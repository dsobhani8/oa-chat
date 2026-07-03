import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const ENV_PATH = path.join(ROOT_DIR, '.env');
const STORE_PATH = process.env.BILLING_DEMO_STORE ||
    path.join(os.tmpdir(), 'oa-chat-billing-demo-store.json');

loadEnvFile(ENV_PATH);

const PORT = Number.parseInt(process.env.BILLING_SERVER_PORT || '4242', 10);
const HOST = process.env.BILLING_SERVER_HOST || '127.0.0.1';
const APP_URL = process.env.APP_URL || 'http://localhost:8091';
const ALLOWED_RETURN_ORIGINS = parseAllowedOrigins(process.env.BILLING_ALLOWED_RETURN_ORIGINS || '');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_API_BASE_URL = process.env.STRIPE_API_BASE_URL || 'https://api.stripe.com';
const PREMIUM_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID ||
    process.env.STRIPE_STARTER_PRICE_ID ||
    '';
const DEMO_RENEWAL_SECONDS = parsePositiveInt(process.env.BILLING_DEMO_RENEWAL_SECONDS, 0);
const DEMO_RENEWAL_TICKETS = parsePositiveInt(process.env.BILLING_DEMO_RENEWAL_TICKETS, 0);
const WEBHOOK_TOLERANCE_SECONDS = 300;
const TICKET_LINK_TTL_DAYS = Number.parseInt(process.env.BILLING_TICKET_LINK_TTL_DAYS || '30', 10);
const SMTP_TIMEOUT_MS = Number.parseInt(process.env.SMTP_TIMEOUT_MS || '10000', 10);
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number.parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.MAIL_FROM || SMTP_USER || 'Open Anonymity <no-reply@localhost>';
const SMTP_SECURE = process.env.SMTP_SECURE !== 'false';
const DEMO_ACCOUNT_HEADER = 'x-oa-demo-account-id';
const DEMO_SIGNING_SECRET = process.env.BILLING_DEMO_SIGNING_SECRET ||
    crypto.createHash('sha256').update(`${STRIPE_SECRET_KEY}:oa-demo-ticket-signer`).digest('hex');

const PLAN_BY_PRICE = new Map([
    [PREMIUM_PRICE_ID, {
        id: 'premium',
        name: 'Premium',
        monthlyTickets: 500,
        monthlyPriceUsd: 35
    }]
].filter(([priceId]) => typeof priceId === 'string' && priceId.startsWith('price_')));

const store = loadStore();
const accountSubscriptionCheckoutCreations = new Map();

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'OPTIONS') {
            sendJson(res, 204, {});
            return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && url.pathname === '/health') {
            sendJson(res, 200, {
                ok: true,
                appUrl: APP_URL,
                storePath: STORE_PATH,
                configured: {
                    stripeSecretKey: isConfigured(STRIPE_SECRET_KEY, 'sk_') ||
                        isConfigured(STRIPE_SECRET_KEY, 'rk_'),
                    webhookSecret: isConfigured(STRIPE_WEBHOOK_SECRET, 'whsec_'),
                    premiumPriceId: isConfigured(PREMIUM_PRICE_ID, 'price_'),
                    starterPriceId: isConfigured(PREMIUM_PRICE_ID, 'price_'),
                    demoRenewalSeconds: DEMO_RENEWAL_SECONDS
                }
            });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/billing/checkout') {
            await handleCheckout(req, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/billing/portal') {
            await handlePortal(req, res);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/billing/status') {
            handleStatus(req, url, res);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/billing/tickets/claim') {
            await handleAccountTicketsClaim(req, res);
            return;
        }

        const ticketLinkStatusMatch = url.pathname.match(/^\/api\/ticket-links\/([^/]+)$/);
        if (req.method === 'GET' && ticketLinkStatusMatch) {
            handleTicketLinkStatus(ticketLinkStatusMatch[1], res);
            return;
        }

        const ticketLinkClaimMatch = url.pathname.match(/^\/api\/ticket-links\/([^/]+)\/claim$/);
        if (req.method === 'POST' && ticketLinkClaimMatch) {
            await handleTicketLinkClaim(req, res, ticketLinkClaimMatch[1]);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') {
            await handleWebhook(req, res);
            return;
        }

        sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
        console.error(error);
        sendJson(res, 500, { error: error.message || 'Internal server error' });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Billing demo server listening on http://${HOST}:${PORT}`);
    console.log(`Stripe webhook target: http://${HOST}:${PORT}/api/stripe/webhook`);
    console.log(`Frontend APP_URL: ${APP_URL}`);
    console.log(`Demo store: ${STORE_PATH}`);
    void processResolvablePendingPaidInvoices();
});

async function handleCheckout(req, res) {
    requireStripeConfig();
    const sessionAccountId = getDemoAccountSession(req);
    if (!sessionAccountId) {
        sendJson(res, 401, { error: 'Account session is required.' });
        return;
    }
    const body = await readJson(req);
    const returnOrigin = resolveReturnOrigin(body.return_origin, req.headers.origin);
    if (!returnOrigin) {
        sendJson(res, 400, { error: 'Return origin is not allowed.' });
        return;
    }

    await startAccountSubscriptionCheckout(res, sessionAccountId, returnOrigin);
}

async function startAccountSubscriptionCheckout(res, accountId, returnOrigin = buildAppReturnOrigin()) {
    if (!PREMIUM_PRICE_ID || !PLAN_BY_PRICE.has(PREMIUM_PRICE_ID)) {
        sendJson(res, 500, { error: 'STRIPE_PREMIUM_PRICE_ID is not configured.' });
        return;
    }

    const account = ensureBillingAccountRecord(accountId);
    if (hasCurrentPremiumSubscription(account)) {
        sendJson(res, 409, { error: 'Premium is already linked to this account.' });
        return;
    }
    const pendingCheckout = getReusablePendingCheckout(account, 'subscription', returnOrigin);
    if (pendingCheckout) {
        sendJson(res, 200, {
            url: pendingCheckout.url,
            pendingCheckout: true,
            sessionId: pendingCheckout.sessionId
        });
        return;
    }

    const result = await getOrCreateAccountSubscriptionCheckout(account, returnOrigin);
    sendJson(res, result.status, result.body);
}

async function getOrCreateAccountSubscriptionCheckout(account, returnOrigin = buildAppReturnOrigin()) {
    const lockKey = `${account.accountId}:${PREMIUM_PRICE_ID}:${returnOrigin}`;
    let inFlight = accountSubscriptionCheckoutCreations.get(lockKey);
    if (!inFlight) {
        inFlight = createAccountSubscriptionCheckout(account, returnOrigin)
            .finally(() => {
                accountSubscriptionCheckoutCreations.delete(lockKey);
            });
        accountSubscriptionCheckoutCreations.set(lockKey, inFlight);
    }
    return inFlight;
}

async function createAccountSubscriptionCheckout(account, returnOrigin = buildAppReturnOrigin()) {
    if (hasCurrentPremiumSubscription(account)) {
        return {
            status: 409,
            body: { error: 'Premium is already linked to this account.' }
        };
    }
    const pendingCheckout = getReusablePendingCheckout(account, 'subscription', returnOrigin);
    if (pendingCheckout) {
        return {
            status: 200,
            body: {
                url: pendingCheckout.url,
                pendingCheckout: true,
                sessionId: pendingCheckout.sessionId
            }
        };
    }

    const checkoutReturnUrls = buildCheckoutReturnUrls(returnOrigin);
    const sessionParams = {
        mode: 'subscription',
        success_url: checkoutReturnUrls.successUrl,
        cancel_url: checkoutReturnUrls.cancelUrl,
        client_reference_id: account.accountId,
        'metadata[oa_account_id]': account.accountId,
        'subscription_data[metadata][oa_account_id]': account.accountId,
        'line_items[0][price]': PREMIUM_PRICE_ID,
        'line_items[0][quantity]': '1'
    };

    if (account.stripeCustomerId) {
        sessionParams.customer = account.stripeCustomerId;
    } else if (account.billingEmail) {
        sessionParams.customer_email = account.billingEmail;
    }

    const session = await stripeRequest('/v1/checkout/sessions', sessionParams);
    recordCheckoutSession(session, {
        accountId: account.accountId,
        checkoutType: 'subscription',
        mode: 'subscription',
        priceId: PREMIUM_PRICE_ID,
        ticketCount: PLAN_BY_PRICE.get(PREMIUM_PRICE_ID).monthlyTickets,
        checkoutReturnUrls
    });
    account.pendingCheckout = {
        sessionId: session.id,
        type: 'subscription',
        url: session.url,
        expiresAt: session.expires_at
            ? new Date(session.expires_at * 1000).toISOString()
            : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        appUrl: buildAppReturnUrl({}, returnOrigin),
        returnOrigin,
        createdAt: new Date().toISOString()
    };
    saveStore();

    return {
        status: 200,
        body: { url: session.url }
    };
}

async function handlePortal(req, res) {
    requireStripeConfig();
    const sessionAccountId = getDemoAccountSession(req);
    if (!sessionAccountId) {
        sendJson(res, 401, { error: 'Account session is required.' });
        return;
    }
    const body = await readJson(req);
    const returnOrigin = resolveReturnOrigin(body.return_origin, req.headers.origin);
    if (!returnOrigin) {
        sendJson(res, 400, { error: 'Return origin is not allowed.' });
        return;
    }

    const account = store.accounts?.[sessionAccountId] || null;
    if (!account?.stripeCustomerId) {
        sendJson(res, 404, { error: 'No Stripe customer exists for this account yet.' });
        return;
    }

    const portalSession = await stripeRequest('/v1/billing_portal/sessions', {
        customer: account.stripeCustomerId,
        return_url: buildAppReturnUrl({ billing: 'portal' }, returnOrigin)
    });

    sendJson(res, 200, { url: portalSession.url });
}

function handleStatus(req, url, res) {
    const sessionAccountId = getDemoAccountSession(req);
    const debugAccountId = normalizeAccountId(url.searchParams.get('account_id'));
    if (sessionAccountId) {
        maybeCreateDemoRenewalEntitlement(sessionAccountId);
        sendJson(res, 200, buildAccountStatus(sessionAccountId));
        return;
    }

    if (debugAccountId) {
        sendJson(res, 200, buildAccountDebugStatus(debugAccountId));
        return;
    }

    sendJson(res, 401, { error: 'Account session is required.' });
}

function handleTicketLinkStatus(rawCode, res) {
    const link = getTicketLink(rawCode);
    if (!link) {
        sendJson(res, 404, { error: 'Ticket link was not found.' });
        return;
    }
    if (isTicketLinkExpired(link)) {
        link.status = 'expired';
        saveStore();
        sendJson(res, 410, { error: 'Ticket link has expired.' });
        return;
    }

    sendJson(res, 200, buildTicketLinkPublicStatus(link));
}

async function handleTicketLinkClaim(req, res, rawCode) {
    const link = getTicketLink(rawCode);
    if (!link) {
        sendJson(res, 404, { error: 'Ticket link was not found.' });
        return;
    }
    if (isTicketLinkExpired(link)) {
        link.status = 'expired';
        saveStore();
        sendJson(res, 410, { error: 'Ticket link has expired.' });
        return;
    }

    const body = await readJson(req);
    const blindedRequests = Array.isArray(body.blinded_requests)
        ? body.blinded_requests.map(String).filter(Boolean)
        : [];
    sendTicketLinkClaimResponse(res, link, blindedRequests);
}

function sendTicketLinkClaimResponse(res, link, blindedRequests, options = {}) {
    const { includeTicketLink = true, ...extra } = options || {};
    const ticketCount = Math.max(0, Math.floor(Number(link.ticketCount) || 0));
    if (ticketCount <= 0) {
        sendJson(res, 400, { error: 'Ticket link does not have tickets to issue.' });
        return;
    }
    if (blindedRequests.length !== ticketCount) {
        sendJson(res, 400, {
            error: `Ticket link requires ${ticketCount} blinded requests.`
        });
        return;
    }

    const claimId = buildTicketLinkClaimId(link, blindedRequests);
    const requestHash = buildBlindedRequestHash(blindedRequests);
    if (link.claimId) {
        const existingClaim = store.claims[link.claimId];
        if (existingClaim &&
            link.claimId === claimId &&
            existingClaim.requestHash === requestHash &&
            isCompleteReplayableClaim(existingClaim, blindedRequests.length)) {
            sendJson(res, 200, {
                ...buildTicketClaimResponse(existingClaim, {
                    replayed: true,
                    includeStatus: false
                }),
                ...(includeTicketLink ? { ticket_link: buildTicketLinkPublicStatus(link) } : {}),
                ...extra
            });
            return;
        }
        sendJson(res, 409, { error: 'Ticket link has already been redeemed.' });
        return;
    }

    const allocation = allocateTicketLinkEntitlement(link, blindedRequests.length);
    if (allocation.error) {
        sendJson(res, 400, { error: allocation.error });
        return;
    }

    const signed = blindedRequests.map((blindedRequest, index) => ({
        index,
        signed_blinded_response: signBlindedRequest(blindedRequest)
    }));
    const claim = {
        id: claimId,
        accountId: link.accountId || null,
        entitlementId: link.entitlementId,
        requestHash,
        requestCount: blindedRequests.length,
        signedBlindedResponses: signed,
        ticketsIssued: signed.length,
        ticketMode: 'demo',
        ticketLinkCode: link.code,
        allocations: allocation.allocations,
        createdAt: new Date().toISOString()
    };

    store.claims[claimId] = claim;
    link.claimId = claimId;
    link.status = 'claimed';
    link.claimedAt = new Date().toISOString();
    saveStore();

    sendJson(res, 200, {
        ...buildTicketClaimResponse(claim, { includeStatus: false }),
        ...(includeTicketLink ? { ticket_link: buildTicketLinkPublicStatus(link) } : {}),
        ...extra
    });
}

async function handleAccountTicketsClaim(req, res) {
    const accountId = getDemoAccountSession(req);
    if (!accountId) {
        sendJson(res, 401, { error: 'Account session is required.' });
        return;
    }

    const body = await readJson(req);
    const bodyKeys = Object.keys(body || {});
    if (bodyKeys.some(key => key !== 'blinded_requests')) {
        sendJson(res, 400, { error: 'Ticket claim body must contain only blinded requests.' });
        return;
    }

    const blindedRequests = Array.isArray(body.blinded_requests)
        ? body.blinded_requests.map(String).filter(Boolean)
        : [];
    if (blindedRequests.length === 0) {
        sendJson(res, 400, { error: 'At least one blinded request is required.' });
        return;
    }

    const priorReplayClaim = findReplayableAccountClaimForAccount(accountId, blindedRequests);
    if (priorReplayClaim) {
        sendJson(res, 200, buildAccountClaimResponse(accountId, priorReplayClaim, { replayed: true }));
        return;
    }

    const entitlement = getNextAccountClaimableEntitlement(accountId);
    if (!entitlement) {
        sendJson(res, 400, { error: 'No Premium ticket batch is ready to claim.', status: buildAccountStatus(accountId) });
        return;
    }

    const replayClaim = findReplayableAccountClaim(accountId, entitlement.id, blindedRequests);
    if (replayClaim) {
        sendJson(res, 200, buildAccountClaimResponse(accountId, replayClaim, { replayed: true }));
        return;
    }

    const claimable = getAccountClaimableTicketCount(entitlement);
    if (blindedRequests.length !== claimable) {
        sendJson(res, 400, {
            error: `This Premium batch requires ${claimable} blinded requests.`,
            status: buildAccountStatus(accountId)
        });
        return;
    }

    const claimId = buildAccountClaimId(accountId, entitlement.id, blindedRequests);
    const existingClaim = store.claims[claimId];
    if (existingClaim && isCompleteReplayableClaim(existingClaim, blindedRequests.length)) {
        sendJson(res, 200, buildAccountClaimResponse(accountId, existingClaim, { replayed: true }));
        return;
    }

    const signed = blindedRequests.map((blindedRequest, index) => ({
        index,
        signed_blinded_response: signBlindedRequest(blindedRequest)
    }));
    entitlement.blindTicketsIssued += signed.length;
    entitlement.fulfilledAt = new Date().toISOString();

    const claim = {
        id: claimId,
        accountId,
        entitlementId: entitlement.id,
        requestHash: buildBlindedRequestHash(blindedRequests),
        requestCount: blindedRequests.length,
        signedBlindedResponses: signed,
        ticketsIssued: signed.length,
        ticketMode: 'demo',
        createdAt: new Date().toISOString()
    };
    store.claims[claimId] = claim;
    markTicketLinksClaimedForEntitlement(entitlement.id, claimId);
    saveStore();

    sendJson(res, 200, buildAccountClaimResponse(accountId, claim));
}

async function handleWebhook(req, res) {
    const rawBody = await readRaw(req);
    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'])) {
        sendJson(res, 400, { error: 'Invalid Stripe webhook signature.' });
        return;
    }

    const event = JSON.parse(rawBody);
    if (store.stripeEvents[event.id]) {
        const retryResult = await retryDuplicateInvoicePaidDelivery(event);
        sendJson(res, 200, {
            received: true,
            duplicate: true,
            deliveryRetried: retryResult.retried > 0,
            retriedLinks: retryResult.retried
        });
        return;
    }

    let result = null;
    let shouldRecordEvent = true;
    if (event.type === 'checkout.session.completed') {
        await handleCheckoutCompleted(event.data.object, event.created);
    } else if (event.type === 'invoice.paid') {
        result = await handleInvoicePaid(event.data.object, event.created);
        shouldRecordEvent = !result?.ignored && !result?.pending;
    } else if (event.type === 'invoice.payment_failed') {
        await handleInvoicePaymentFailed(event.data.object, event.created);
    } else if (event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted') {
        handleSubscriptionChanged(event.data.object, event.created);
    }

    if (shouldRecordEvent) {
        store.stripeEvents[event.id] = {
            type: event.type,
            processedAt: new Date().toISOString()
        };
        saveStore();
    }

    sendJson(res, 200, {
        received: true,
        deferred: result?.pending === true,
        ignored: result?.ignored === true
    });
}

async function retryDuplicateInvoicePaidDelivery(event) {
    if (event?.type !== 'invoice.paid') return { retried: 0 };
    const invoice = event.data?.object;
    const invoiceId = invoice?.id;
    if (!invoiceId) return { retried: 0 };

    const retryLinks = Object.values(store.ticketLinks || {}).filter(link =>
        link?.stripeInvoiceId === invoiceId &&
        link.deliveryMethod === 'console-fallback'
    );

    for (const link of retryLinks) {
        await deliverTicketLinkEmail(link);
    }

    return { retried: retryLinks.length };
}

async function handleCheckoutCompleted(session, eventCreated) {
    const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
    const email = resolveEmailFromCheckoutSession(session);
    const accountId = resolveAccountIdFromCheckoutSession(session);

    if (accountId) {
        const account = ensureBillingAccountRecord(accountId);
        if (email) {
            linkBillingAccountEmail(account, email);
            ensureAccountRecord(email);
        }
        if (customerId) {
            account.stripeCustomerId = customerId;
        }
        account.pendingCheckout = null;
        updateCheckoutSessionRecord(session.id, {
            accountId,
            email: email || account.billingEmail || null,
            billingEmail: email || account.billingEmail || null,
            stripeCustomerId: customerId || null,
            stripeSubscriptionId: getCheckoutSessionSubscriptionId(session),
            status: 'completed',
            completedAt: eventCreatedIso(eventCreated)
        });

        if (session.mode === 'payment') {
            updateCheckoutSessionRecord(session.id, {
                status: 'ignored',
                deliveryError: 'One-time payment Checkout Sessions are not part of the Premium MVP.'
            });
            saveStore();
            return;
        }

        const subscriptionId = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (subscriptionId &&
            shouldApplyCheckoutCompletedUpdate(account, subscriptionId) &&
            shouldApplySubscriptionUpdate(account, eventCreated)) {
            account.subscription = {
                id: subscriptionId,
                status: 'checkout_completed',
                cancelAtPeriodEnd: false,
                currentPeriodStart: null,
                currentPeriodEnd: null,
                updatedAt: eventCreatedIso(eventCreated),
                stripeEventCreated: normalizeStripeEventCreated(eventCreated)
            };
        }

        await processPendingPaidInvoicesForCustomer(customerId, email || account.billingEmail, accountId);
        saveStore();
        return;
    }

    updateCheckoutSessionRecord(session.id, {
        status: 'ignored',
        deliveryError: 'Checkout Session did not include an OA account ID.'
    });
    saveStore();
}

async function handleInvoicePaid(invoice, eventCreated, emailOverride = null) {
    const override = normalizeInvoiceOverride(emailOverride);
    const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
    const accountId = override.accountId || findAccountIdByInvoice(invoice);
    const email = override.email ||
        (accountId ? findBillingEmailByAccountId(accountId) : '') ||
        findEmailByInvoice(invoice);
    if (!accountId) {
        storePendingPaidInvoice(invoice, eventCreated);
        console.warn(`Queued invoice.paid for unresolved OA account ${customerId || '(none)'}`);
        return { pending: true };
    }
    const lines = Array.isArray(invoice.lines?.data) ? invoice.lines.data : [];
    const paidLine = lines.find(line => {
        const priceId = getInvoiceLinePriceId(line);
        return PLAN_BY_PRICE.has(priceId);
    });
    if (!paidLine) {
        const observedPrices = lines
            .map(line => getInvoiceLinePriceId(line))
            .filter(Boolean)
            .join(', ') || '(none)';
        const configuredPrices = Array.from(PLAN_BY_PRICE.keys()).join(', ') || '(none)';
        console.warn(
            `Ignoring invoice.paid without configured Premium price: ${invoice.id || '(unknown invoice)'}` +
            `; configured prices: ${configuredPrices}; invoice prices: ${observedPrices}`
        );
        return { ignored: true };
    }

    const priceId = getInvoiceLinePriceId(paidLine);
    const plan = PLAN_BY_PRICE.get(priceId);
    const customer = email ? ensureAccountRecord(email) : null;
    const account = ensureBillingAccountRecord(accountId);
    if (email) {
        linkBillingAccountEmail(account, email);
    }
    if (customerId) {
        if (customer) customer.stripeCustomerId = customerId;
        account.stripeCustomerId = customerId;
    }
    if (customer) customer.pendingCheckout = null;
    account.pendingCheckout = null;
    const invoiceSubscriptionId = getInvoiceSubscriptionId(invoice);
    const subscriptionUpdate = invoiceSubscriptionId
        ? {
            id: invoiceSubscriptionId,
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodStart: invoice.period_start
                ? new Date(invoice.period_start * 1000).toISOString()
                : null,
            currentPeriodEnd: invoice.period_end
                ? new Date(invoice.period_end * 1000).toISOString()
                : null,
            updatedAt: eventCreatedIso(eventCreated),
            stripeEventCreated: normalizeStripeEventCreated(eventCreated)
        }
        : null;
    if (subscriptionUpdate && customer && shouldApplySubscriptionUpdate(customer, eventCreated)) {
        customer.subscription = subscriptionUpdate;
    }
    if (subscriptionUpdate && shouldApplySubscriptionUpdate(account, eventCreated)) {
        account.subscription = subscriptionUpdate;
    }

    const entitlementId = `${invoice.id}:${paidLine.id || priceId}`;
    if (store.entitlements[entitlementId]) {
        const existingLink = ensureSubscriptionTicketLink({
            email,
            accountId,
            entitlementId,
            invoice,
            plan,
            periodStart: store.entitlements[entitlementId].periodStart,
            periodEnd: store.entitlements[entitlementId].periodEnd
        });
        saveStore();
        await deliverTicketLinkEmail(existingLink);
        return { ticketLink: existingLink };
    }

    const periodStartSec = paidLine.period?.start || invoice.period_start || invoice.created || null;
    const periodEndSec = paidLine.period?.end || invoice.period_end || null;

    store.entitlements[entitlementId] = {
        id: entitlementId,
        userId: accountUserId(accountId),
        accountId,
        email: email || null,
        sourceType: 'subscription',
        planId: plan.id,
        planName: plan.name,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: invoiceSubscriptionId,
        stripePriceId: priceId,
        periodStart: periodStartSec
            ? new Date(periodStartSec * 1000).toISOString()
            : null,
        periodEnd: periodEndSec
            ? new Date(periodEndSec * 1000).toISOString()
            : null,
        ticketsEntitled: plan.monthlyTickets,
        blindTicketsIssued: 0,
        status: 'active',
        createdAt: new Date().toISOString()
    };

    const ticketLink = ensureSubscriptionTicketLink({
        email,
        accountId,
        entitlementId,
        invoice,
        plan,
        periodStart: store.entitlements[entitlementId].periodStart,
        periodEnd: store.entitlements[entitlementId].periodEnd
    });
    saveStore();
    await deliverTicketLinkEmail(ticketLink);
    return { ticketLink };
}

function storePendingPaidInvoice(invoice, eventCreated, options = {}) {
    const invoiceId = invoice?.id || `pending_${crypto.randomBytes(8).toString('hex')}`;
    const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id || null;
    store.pendingInvoices[invoiceId] = {
        invoice,
        eventCreated,
        accountId: normalizeAccountId(options.accountId),
        stripeCustomerId: customerId,
        createdAt: new Date().toISOString()
    };
    saveStore();
}

async function processPendingPaidInvoicesForCustomer(customerId, email, accountId = null) {
    if (!customerId || (!email && !accountId)) return;
    const normalizedAccountId = normalizeAccountId(accountId);
    const entries = Object.entries(store.pendingInvoices || {})
        .filter(([, pending]) =>
            pending?.stripeCustomerId === customerId &&
            (!normalizedAccountId || !pending.accountId || pending.accountId === normalizedAccountId)
        );

    for (const [invoiceId, pending] of entries) {
        const result = await handleInvoicePaid(pending.invoice, pending.eventCreated, {
            email,
            accountId: normalizedAccountId || pending.accountId || null
        });
        if (result?.ignored || result?.pending) {
            continue;
        }
        delete store.pendingInvoices[invoiceId];
        saveStore();
    }
}

async function processResolvablePendingPaidInvoices() {
    const entries = Object.entries(store.pendingInvoices || {});
    for (const [invoiceId, pending] of entries) {
        const customerId = pending?.stripeCustomerId;
        const accountId = pending?.accountId || findAccountIdByCustomerId(customerId) || findAccountIdByInvoice(pending?.invoice);
        const email = (accountId ? findBillingEmailByAccountId(accountId) : '') ||
            findEmailByCustomerId(customerId) ||
            findEmailByInvoice(pending?.invoice);
        if (!email && !accountId) continue;

        const result = await handleInvoicePaid(pending.invoice, pending.eventCreated, { email, accountId });
        if (result?.ignored || result?.pending) {
            continue;
        }
        delete store.pendingInvoices[invoiceId];
        saveStore();
    }
}

async function handleInvoicePaymentFailed(invoice, eventCreated) {
    const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
    const email = findEmailByCustomerId(customerId);
    const accountId = findAccountIdByCustomerId(customerId) || findAccountIdByInvoice(invoice);
    if (!email && !accountId) return;

    if (email) {
        const customer = store.customers[email] ||= {};
        customer.lastPaymentFailedAt = eventCreatedIso(eventCreated);
        customer.lastFailedInvoiceId = invoice.id;
    }
    if (accountId) {
        const account = ensureBillingAccountRecord(accountId);
        account.lastPaymentFailedAt = eventCreatedIso(eventCreated);
        account.lastFailedInvoiceId = invoice.id;
    }
}

function handleSubscriptionChanged(subscription, eventCreated) {
    const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;
    const email = findEmailByCustomerId(customerId);
    const accountId = findAccountIdByCustomerId(customerId) ||
        normalizeAccountId(subscription.metadata?.oa_account_id);
    if (!email && !accountId) return;

    const subscriptionState = {
        id: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
        currentPeriodStart: subscription.current_period_start
            ? new Date(subscription.current_period_start * 1000).toISOString()
            : null,
        currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
        updatedAt: eventCreatedIso(eventCreated),
        stripeEventCreated: normalizeStripeEventCreated(eventCreated)
    };

    if (email) {
        const customer = store.customers[email] ||= {};
        if (shouldApplySubscriptionUpdate(customer, eventCreated)) {
            customer.subscription = subscriptionState;
        }
    }

    if (accountId) {
        const account = ensureBillingAccountRecord(accountId);
        if (shouldApplySubscriptionUpdate(account, eventCreated)) {
            account.subscription = subscriptionState;
        }
    }
}

function buildAccountStatus(accountId) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const account = normalizedAccountId ? store.accounts?.[normalizedAccountId] || null : null;
    const entitlements = Object.values(store.entitlements)
        .filter(entitlement => entitlement.accountId === normalizedAccountId)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    const activeEntitlements = entitlements.filter(entitlement =>
        entitlement.status === 'active'
    );

    const totals = activeEntitlements.reduce((acc, entitlement) => {
        acc.ticketsEntitled += entitlement.ticketsEntitled;
        acc.blindTicketsIssued += entitlement.blindTicketsIssued;
        acc.claimableTickets += getAccountClaimableTicketCount(entitlement);
        return acc;
    }, {
        ticketsEntitled: 0,
        blindTicketsIssued: 0,
        claimableTickets: 0
    });
    const nextClaimableEntitlement = getNextAccountClaimableEntitlement(normalizedAccountId);
    const nextClaimableTickets = nextClaimableEntitlement
        ? getAccountClaimableTicketCount(nextClaimableEntitlement)
        : 0;

    return {
        accountId: normalizedAccountId,
        accountExists: !!account,
        billingEmail: account?.billingEmail || null,
        stripeCustomerId: account?.stripeCustomerId || null,
        subscription: account?.subscription || null,
        unclaimedTickets: totals.claimableTickets,
        nextClaimableTickets,
        ...totals,
        entitlements: entitlements.map(entitlement => {
            const isActive = entitlement.status === 'active';
            return {
                id: entitlement.id,
                sourceType: entitlement.sourceType,
                planId: entitlement.planId,
                planName: entitlement.planName,
                periodStart: entitlement.periodStart,
                periodEnd: entitlement.periodEnd,
                ticketsEntitled: entitlement.ticketsEntitled,
                blindTicketsIssued: entitlement.blindTicketsIssued,
                claimableTickets: isActive
                    ? getAccountClaimableTicketCount(entitlement)
                    : 0,
                status: isActive ? entitlement.status : 'expired'
            };
        })
    };
}

function buildAccountDebugStatus(accountId) {
    const status = buildAccountStatus(accountId);
    const subscription = status.subscription
        ? {
            status: status.subscription.status || null,
            cancelAtPeriodEnd: !!status.subscription.cancelAtPeriodEnd,
            currentPeriodStart: status.subscription.currentPeriodStart || null,
            currentPeriodEnd: status.subscription.currentPeriodEnd || null
        }
        : null;

    return {
        accountId: status.accountId,
        accountExists: status.accountExists,
        subscription,
        ticketsEntitled: status.ticketsEntitled,
        blindTicketsIssued: status.blindTicketsIssued,
        claimableTickets: status.claimableTickets,
        unclaimedTickets: status.unclaimedTickets,
        nextClaimableTickets: status.nextClaimableTickets,
        entitlements: (status.entitlements || []).map(entitlement => ({
            sourceType: entitlement.sourceType,
            planId: entitlement.planId,
            planName: entitlement.planName,
            periodStart: entitlement.periodStart,
            periodEnd: entitlement.periodEnd,
            ticketsEntitled: entitlement.ticketsEntitled,
            blindTicketsIssued: entitlement.blindTicketsIssued,
            claimableTickets: entitlement.claimableTickets,
            status: entitlement.status
        }))
    };
}

function maybeCreateDemoRenewalEntitlement(accountId) {
    const normalizedAccountId = normalizeAccountId(accountId);
    if (!normalizedAccountId || DEMO_RENEWAL_SECONDS <= 0) return null;

    const account = store.accounts?.[normalizedAccountId] || null;
    if (!hasPaidPremiumSubscription(account)) return null;

    const subscription = account.subscription || {};
    const subscriptionId = subscription.id || 'unknown_subscription';
    const anchorMs = getDemoRenewalAnchorMs(account);
    if (!Number.isFinite(anchorMs)) return null;

    const intervalMs = DEMO_RENEWAL_SECONDS * 1000;
    const nowMs = Date.now();
    const periodIndex = Math.floor((nowMs - anchorMs) / intervalMs);
    if (periodIndex < 1) return null;

    const entitlementId = `demo-renewal:${normalizedAccountId}:${subscriptionId}:${periodIndex}`;
    if (store.entitlements[entitlementId]) return store.entitlements[entitlementId];

    const periodStartMs = anchorMs + periodIndex * intervalMs;
    const periodEndMs = periodStartMs + intervalMs;
    const ticketCount = DEMO_RENEWAL_TICKETS > 0
        ? DEMO_RENEWAL_TICKETS
        : PLAN_BY_PRICE.get(PREMIUM_PRICE_ID)?.monthlyTickets || 500;
    const entitlement = {
        id: entitlementId,
        userId: accountUserId(normalizedAccountId),
        accountId: normalizedAccountId,
        email: account.billingEmail || account.email || null,
        sourceType: 'subscription_demo_renewal',
        planId: 'premium',
        planName: 'Premium',
        stripeSubscriptionId: subscription.id || null,
        stripePriceId: PREMIUM_PRICE_ID || null,
        periodStart: new Date(periodStartMs).toISOString(),
        periodEnd: new Date(periodEndMs).toISOString(),
        demoRenewalPeriodIndex: periodIndex,
        demoRenewalIntervalSeconds: DEMO_RENEWAL_SECONDS,
        ticketsEntitled: ticketCount,
        blindTicketsIssued: 0,
        status: 'active',
        createdAt: new Date().toISOString()
    };
    store.entitlements[entitlementId] = entitlement;
    saveStore();
    return entitlement;
}

function getDemoRenewalAnchorMs(account) {
    const subscription = account?.subscription || {};
    const candidates = [
        subscription.currentPeriodStart,
        subscription.updatedAt,
        account.createdAt
    ];
    for (const candidate of candidates) {
        const parsed = Date.parse(candidate || '');
        if (Number.isFinite(parsed)) return parsed;
    }
    return NaN;
}

function getNextAccountClaimableEntitlement(accountId) {
    const normalizedAccountId = normalizeAccountId(accountId);
    if (!normalizedAccountId) return null;
    return Object.values(store.entitlements)
        .filter(entitlement =>
            entitlement.accountId === normalizedAccountId &&
            entitlement.status === 'active' &&
            getAccountClaimableTicketCount(entitlement) > 0
        )
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0] || null;
}

function allocateTicketLinkEntitlement(link, count) {
    const entitlement = store.entitlements?.[link?.entitlementId] || null;
    if (!entitlement) {
        return { error: 'Ticket link entitlement was not found.' };
    }
    if (entitlement.status !== 'active') {
        return { error: 'Ticket link entitlement is not active.' };
    }

    const claimable = getAccountClaimableTicketCount(entitlement);
    if (claimable !== count) {
        return {
            error: `Ticket link requires ${claimable} blinded requests.`
        };
    }

    entitlement.blindTicketsIssued += count;
    entitlement.fulfilledAt = new Date().toISOString();
    return {
        allocations: [{
            entitlementId: entitlement.id,
            planId: entitlement.planId,
            planName: entitlement.planName,
            stripeInvoiceId: entitlement.stripeInvoiceId,
            periodStart: entitlement.periodStart,
            periodEnd: entitlement.periodEnd,
            ticketsIssued: count
        }]
    };
}

function getAccountClaimableTicketCount(entitlement) {
    return Math.max(0, entitlement.ticketsEntitled - entitlement.blindTicketsIssued);
}

function buildTicketLinkClaimId(link, blindedRequests) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({
            scope: 'subscription_ticket_link',
            ticketLinkCode: link.code,
            entitlementId: link.entitlementId,
            blindedRequests
        }))
        .digest('hex');
}

function buildAccountClaimId(accountId, entitlementId, blindedRequests) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({
            scope: 'account_subscription_claim',
            accountId: normalizeAccountId(accountId),
            entitlementId,
            blindedRequests
        }))
        .digest('hex');
}

function buildBlindedRequestHash(blindedRequests) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(blindedRequests))
        .digest('hex');
}

function findReplayableAccountClaim(accountId, entitlementId, blindedRequests) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const requestHash = buildBlindedRequestHash(blindedRequests);
    return Object.values(store.claims || {}).find(claim =>
        claim?.accountId === normalizedAccountId &&
        claim?.entitlementId === entitlementId &&
        claim?.requestHash === requestHash &&
        isCompleteReplayableClaim(claim, blindedRequests.length)
    ) || null;
}

function findReplayableAccountClaimForAccount(accountId, blindedRequests) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const requestHash = buildBlindedRequestHash(blindedRequests);
    return Object.values(store.claims || {}).find(claim =>
        claim?.accountId === normalizedAccountId &&
        claim?.requestHash === requestHash &&
        isCompleteReplayableClaim(claim, blindedRequests.length)
    ) || null;
}

function isCompleteReplayableClaim(claim, requestCount) {
    const signedResponses = Array.isArray(claim?.signedBlindedResponses)
        ? claim.signedBlindedResponses
        : [];
    return signedResponses.length === requestCount &&
        Number(claim?.ticketsIssued) === requestCount &&
        signedResponses.every((response, index) =>
            Number(response?.index) === index &&
            typeof response?.signed_blinded_response === 'string' &&
            response.signed_blinded_response.length > 0
        );
}

function buildTicketClaimResponse(claim, options = {}) {
    return {
        claim_id: claim.id,
        signed_blinded_responses: claim.signedBlindedResponses || [],
        tickets_issued: Number(claim.ticketsIssued) || 0,
        ticket_mode: claim.ticketMode || 'demo',
        allocations: claim.allocations || [],
        replayed: options.replayed === true
    };
}

function buildAccountClaimResponse(accountId, claim, options = {}) {
    return {
        claim_id: claim.id,
        signed_blinded_responses: claim.signedBlindedResponses || [],
        tickets_issued: Number(claim.ticketsIssued) || 0,
        ticket_mode: claim.ticketMode || 'demo',
        replayed: options.replayed === true,
        status: buildAccountStatus(accountId)
    };
}

function getInvoiceLinePriceId(line) {
    if (!line || typeof line !== 'object') return '';
    if (typeof line.price === 'string') return line.price;
    if (typeof line.price?.id === 'string') return line.price.id;
    const pricingPrice = line.pricing?.price_details?.price;
    if (typeof pricingPrice === 'string') return pricingPrice;
    if (typeof pricingPrice?.id === 'string') return pricingPrice.id;
    return '';
}

function getInvoiceSubscriptionId(invoice) {
    if (!invoice || typeof invoice !== 'object') return null;
    const lines = Array.isArray(invoice.lines?.data) ? invoice.lines.data : [];
    const candidates = [
        invoice.subscription,
        invoice.subscription_details?.subscription,
        invoice.parent?.subscription_details?.subscription,
        invoice.parent?.subscription_item_details?.subscription,
        ...lines.flatMap(line => [
            line?.subscription,
            line?.subscription_details?.subscription,
            line?.subscription_item_details?.subscription,
            line?.parent?.subscription_details?.subscription,
            line?.parent?.subscription_item_details?.subscription
        ])
    ];
    for (const candidate of candidates) {
        const id = getStripeObjectId(candidate);
        if (id) return id;
    }
    return null;
}

function getStripeObjectId(value) {
    if (typeof value === 'string') return value;
    if (typeof value?.id === 'string') return value.id;
    return null;
}

function getCheckoutSessionSubscriptionId(session) {
    if (!session || typeof session !== 'object') return null;
    if (typeof session.subscription === 'string') return session.subscription;
    if (typeof session.subscription?.id === 'string') return session.subscription.id;
    return null;
}

function ensureSubscriptionTicketLink({ email, accountId = null, entitlementId, invoice, plan, periodStart, periodEnd }) {
    const existing = Object.values(store.ticketLinks).find(link =>
        link.entitlementId === entitlementId
    );
    if (existing) {
        linkCheckoutSessionToTicketLink(existing);
        return existing;
    }

    const code = generateTicketCode();
    const createdAt = new Date().toISOString();
    const expiresAt = Number.isFinite(TICKET_LINK_TTL_DAYS) && TICKET_LINK_TTL_DAYS > 0
        ? new Date(Date.now() + TICKET_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
        : null;
    const link = {
        code,
        email: email || null,
        userId: accountId ? accountUserId(accountId) : demoUserId(email),
        accountId: accountId || null,
        entitlementId,
        sourceType: 'subscription',
        planId: plan.id,
        planName: plan.name,
        ticketCount: plan.monthlyTickets,
        ticketMode: 'demo',
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
        periodStart: periodStart || null,
        periodEnd: periodEnd || null,
        status: 'issued',
        createdAt,
        expiresAt
    };
    store.ticketLinks[code] = link;
    linkCheckoutSessionToTicketLink(link);
    return link;
}

function getTicketLink(rawCode) {
    const code = normalizeTicketCode(rawCode);
    return code ? store.ticketLinks[code] || null : null;
}

function buildTicketLinkPublicStatus(link) {
    return {
        type: 'subscription_ticket_link',
        code: link.code,
        plan_id: link.planId,
        plan_name: link.planName,
        ticket_count: Number(link.ticketCount) || 0,
        ticket_mode: link.ticketMode || 'demo',
        status: link.status || 'issued',
        redeemed: !!link.claimId || link.status === 'claimed',
        expires_at: link.expiresAt || null
    };
}

function markTicketLinksClaimedForEntitlement(entitlementId, claimId = null) {
    if (!entitlementId) return;
    Object.values(store.ticketLinks || {}).forEach(link => {
        if (link?.entitlementId !== entitlementId) return;
        if (claimId) {
            link.claimId ||= claimId;
        }
        link.status = 'claimed';
        link.claimedAt ||= new Date().toISOString();
    });
}

function isTicketLinkExpired(link) {
    if (!link?.expiresAt) return false;
    const expiresAt = Date.parse(link.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

async function deliverTicketLinkEmail(link) {
    if (!link) return;

    const ticketUrl = buildTicketLinkUrl(link.code);
    const toEmail = normalizeEmail(link.email);
    if (link.deliveredAt &&
        link.deliveredTicketUrl === ticketUrl &&
        link.deliveryMethod !== 'console-fallback') {
        return;
    }

    const subject = `Your OA ${link.planName || 'Premium'} tickets`;
    const text = [
        `Your ${link.planName || 'Premium'} tickets are ready.`,
        '',
        `Open this link to load ${link.ticketCount} tickets in oa-chat:`,
        ticketUrl,
        '',
        'This link can be redeemed once. The browser creates the final tickets locally.'
    ].join('\n');

    try {
        if (SMTP_HOST && toEmail) {
            await sendSmtpMail({
                to: toEmail,
                from: SMTP_FROM,
                subject,
                text
            });
            link.deliveryMethod = 'smtp';
        } else {
            logTicketEmail({
                to: toEmail || '(no email available)',
                subject,
                ticketUrl,
                ticketCount: link.ticketCount
            });
            link.deliveryMethod = 'console';
        }
        link.deliveredAt = new Date().toISOString();
        link.deliveredTicketUrl = ticketUrl;
        link.deliveredAppUrl = APP_URL;
        link.deliveryError = null;
    } catch (error) {
        link.deliveryError = error.message || 'Unable to deliver ticket link email.';
        console.warn(`Failed to deliver ticket link email to ${toEmail || '(no email available)'}: ${link.deliveryError}`);
        logTicketEmail({
            to: toEmail || '(no email available)',
            subject,
            ticketUrl,
            ticketCount: link.ticketCount
        });
        link.deliveryMethod = 'console-fallback';
        link.deliveredAt = new Date().toISOString();
        link.deliveredTicketUrl = ticketUrl;
        link.deliveredAppUrl = APP_URL;
    } finally {
        link.deliveryAttempts = (Number(link.deliveryAttempts) || 0) + 1;
        saveStore();
    }
}

function recordCheckoutSession(session, { accountId = null, checkoutType, mode, priceId, ticketCount, checkoutReturnUrls }) {
    store.checkoutSessions[session.id] = {
        sessionId: session.id,
        accountId: accountId || null,
        checkoutType,
        mode,
        priceId,
        ticketCount,
        email: null,
        billingEmail: null,
        stripeSubscriptionId: null,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
        url: session.url,
        expiresAt: session.expires_at
            ? new Date(session.expires_at * 1000).toISOString()
            : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        successUrl: checkoutReturnUrls.successUrl,
        cancelUrl: checkoutReturnUrls.cancelUrl,
        appUrl: buildAppReturnUrl(),
        status: 'created',
        createdAt: new Date().toISOString()
    };
}

function updateCheckoutSessionRecord(sessionId, patch) {
    if (!sessionId) return;
    store.checkoutSessions[sessionId] ||= {
        sessionId,
        status: 'unknown',
        createdAt: new Date().toISOString()
    };
    Object.assign(store.checkoutSessions[sessionId], patch);
    linkCheckoutSessionToExistingTicketLink(store.checkoutSessions[sessionId]);
}

function linkCheckoutSessionToTicketLink(link) {
    if (!link) return;
    const session = link.stripeCheckoutSessionId
        ? store.checkoutSessions[link.stripeCheckoutSessionId]
        : findPendingCheckoutSessionForLink(link);
    if (!session) return;
    session.ticketLinkCode = link.code;
    session.ticketCount = link.ticketCount;
    session.status = session.status || 'completed';
    link.stripeCheckoutSessionId = session.sessionId;
}

function linkCheckoutSessionToExistingTicketLink(session) {
    if (!session || session.ticketLinkCode) return null;
    const link = Object.values(store.ticketLinks || {})
        .filter(candidate => isCheckoutSessionCandidateForLink(session, candidate))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    if (!link) return null;
    linkCheckoutSessionToTicketLink(link);
    return link;
}

function findPendingCheckoutSessionForLink(link) {
    const sessions = Object.values(store.checkoutSessions || {})
        .filter(session => isCheckoutSessionCandidateForLink(session, link))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return sessions[0] || null;
}

function isCheckoutSessionCandidateForLink(session, link) {
    if (!session || !link || session.ticketLinkCode) return false;
    if (link.stripeCheckoutSessionId) {
        return link.stripeCheckoutSessionId === session.sessionId;
    }
    if (link.sourceType === 'subscription') {
        if (link.stripeSubscriptionId) {
            return session.checkoutType === 'subscription' &&
                session.stripeSubscriptionId === link.stripeSubscriptionId;
        }
        const email = normalizeEmail(session.email || session.billingEmail || '');
        const accountId = normalizeAccountId(session.accountId);
        return (!session.checkoutType || session.checkoutType === 'subscription') &&
            (
                (link.accountId && accountId && link.accountId === accountId) ||
                (!link.accountId && link.email && email && link.email === email)
            );
    }
    return false;
}

function ensureAccountRecord(email) {
    store.customers[email] ||= {
        email,
        userId: demoUserId(email),
        createdAt: new Date().toISOString()
    };
    return store.customers[email];
}

function ensureBillingAccountRecord(accountId) {
    const normalized = normalizeAccountId(accountId);
    if (!normalized) {
        throw new Error('Account is required.');
    }
    store.accounts ||= {};
    store.accounts[normalized] ||= {
        accountId: normalized,
        userId: accountUserId(normalized),
        createdAt: new Date().toISOString()
    };
    return store.accounts[normalized];
}

function linkBillingAccountEmail(account, email) {
    const normalizedEmail = normalizeEmail(email);
    if (!account || !normalizedEmail) return;
    account.billingEmail = normalizedEmail;
    account.email = normalizedEmail;
}

function hasCurrentPremiumSubscription(account) {
    const subscription = account?.subscription;
    return ['active', 'trialing', 'checkout_completed'].includes(subscription?.status);
}

function getReusablePendingCheckout(account, expectedType = 'subscription', returnOrigin = '') {
    const pending = account?.pendingCheckout;
    if (!pending?.sessionId || !pending?.url) return null;
    const pendingType = pending.type || 'subscription';
    if (pendingType !== expectedType) return null;
    const requestedOrigin = normalizeReturnOrigin(returnOrigin);
    const pendingOrigin = normalizeReturnOrigin(pending.returnOrigin || pending.appUrl || '');
    if (requestedOrigin && pendingOrigin !== requestedOrigin) {
        account.pendingCheckout = null;
        saveStore();
        return null;
    }
    if (isPendingCheckoutExpired(pending)) {
        account.pendingCheckout = null;
        saveStore();
        return null;
    }
    return pending;
}

function isPendingCheckoutExpired(pending) {
    const expiresAtMs = Date.parse(pending?.expiresAt || '');
    if (!Number.isFinite(expiresAtMs)) return false;
    return expiresAtMs <= Date.now() + 30 * 1000;
}

function hasPaidPremiumSubscription(account) {
    const subscription = account?.subscription;
    return ['active', 'trialing'].includes(subscription?.status);
}

async function stripeRequest(endpoint, params) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'object' && !Array.isArray(value)) {
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                body.set(`${key}[${nestedKey}]`, String(nestedValue));
            }
            continue;
        }
        body.set(key, String(value));
    }

    const response = await fetch(`${STRIPE_API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    const data = await response.json();
    if (!response.ok) {
        const message = data?.error?.message || `Stripe API error (${response.status})`;
        throw new Error(message);
    }
    return data;
}

function buildAppReturnOrigin() {
    return normalizeReturnOrigin(APP_URL) || 'http://localhost:8091';
}

function buildAppReturnUrl(params = {}, returnOrigin = buildAppReturnOrigin()) {
    const url = new URL(returnOrigin);
    url.pathname = '/';
    url.search = '';
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, value);
        }
    }
    return url.toString().replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
}

function buildCheckoutReturnUrls(returnOrigin = buildAppReturnOrigin()) {
    return {
        returnOrigin,
        successUrl: buildAppReturnUrl({ billing: 'success', session_id: '{CHECKOUT_SESSION_ID}' }, returnOrigin),
        cancelUrl: buildAppReturnUrl({ billing: 'cancelled' }, returnOrigin)
    };
}

function parseAllowedOrigins(value) {
    return new Set(String(value || '')
        .split(',')
        .map(item => normalizeReturnOrigin(item))
        .filter(Boolean));
}

function normalizeReturnOrigin(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return url.origin;
    } catch {
        return '';
    }
}

function resolveReturnOrigin(value, requestOrigin = '') {
    const requested = normalizeReturnOrigin(value);
    if (String(value || '').trim() && !requested) return '';
    if (!requested) {
        const originHeader = normalizeReturnOrigin(requestOrigin);
        if (originHeader) return isAllowedReturnOrigin(originHeader) ? originHeader : '';
        return buildAppReturnOrigin();
    }
    return isAllowedReturnOrigin(requested) ? requested : '';
}

function isAllowedReturnOrigin(origin) {
    const normalized = normalizeReturnOrigin(origin);
    if (!normalized) return false;
    const appOrigin = buildAppReturnOrigin();
    if (normalized === appOrigin) return true;
    if (ALLOWED_RETURN_ORIGINS.has(normalized)) return true;

    const url = new URL(normalized);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        return true;
    }
    if (url.protocol === 'https:' &&
        /^oa-chat-git-stripe-subscription-mvp-[a-z0-9-]+\.vercel\.app$/i.test(url.hostname)) {
        return true;
    }
    return false;
}

function signBlindedRequest(blindedRequest) {
    return crypto
        .createHmac('sha256', DEMO_SIGNING_SECRET)
        .update(String(blindedRequest))
        .digest('hex');
}

function verifyStripeSignature(rawBody, signatureHeader) {
    if (!isConfigured(STRIPE_WEBHOOK_SECRET, 'whsec_')) {
        console.warn('STRIPE_WEBHOOK_SECRET is not configured.');
        return false;
    }
    if (!signatureHeader) return false;

    const parts = Object.fromEntries(signatureHeader.split(',').map(part => {
        const [key, value] = part.split('=');
        return [key, value];
    }));
    const timestamp = parts.t;
    const expected = parts.v1;
    if (!timestamp || !expected) return false;
    const timestampNumber = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(timestampNumber)) return false;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampNumber);
    if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false;

    const actual = crypto
        .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    } catch {
        return false;
    }
}

function shouldApplySubscriptionUpdate(customer, eventCreated) {
    const incoming = normalizeStripeEventCreated(eventCreated);
    const existing = normalizeStripeEventCreated(customer?.subscription?.stripeEventCreated);
    if (!Number.isFinite(incoming) || !Number.isFinite(existing)) return true;
    return incoming >= existing;
}

function shouldApplyCheckoutCompletedUpdate(customer, subscriptionId) {
    const existing = customer?.subscription;
    if (!existing) return true;
    if (existing.id && existing.id !== subscriptionId) return true;
    return existing.status === 'checkout_completed';
}

function normalizeStripeEventCreated(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function eventCreatedIso(eventCreated) {
    const normalized = normalizeStripeEventCreated(eventCreated);
    return normalized
        ? new Date(normalized * 1000).toISOString()
        : new Date().toISOString();
}

function requireStripeConfig() {
    if (!isConfigured(STRIPE_SECRET_KEY, 'sk_') && !isConfigured(STRIPE_SECRET_KEY, 'rk_')) {
        throw new Error('STRIPE_SECRET_KEY is not configured.');
    }
}

function findEmailByCustomerId(customerId) {
    if (!customerId) return null;
    return Object.keys(store.customers).find(email =>
        store.customers[email]?.stripeCustomerId === customerId
    ) || null;
}

function findAccountIdByCustomerId(customerId) {
    if (!customerId) return null;
    return Object.keys(store.accounts || {}).find(accountId =>
        store.accounts[accountId]?.stripeCustomerId === customerId
    ) || null;
}

function resolveEmailFromCheckoutSession(session) {
    const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
    const accountId = resolveAccountIdFromCheckoutSession(session);
    const existingEmail = (accountId ? findBillingEmailByAccountId(accountId) : '') ||
        findEmailByCustomerId(customerId);
    if (existingEmail) return existingEmail;
    return normalizeEmail(
        session.customer_details?.email ||
        session.customer_email ||
        session.customer?.email ||
        ''
    );
}

function resolveAccountIdFromCheckoutSession(session) {
    const stored = session?.id ? store.checkoutSessions?.[session.id]?.accountId : null;
    const metadataAccountId = session?.metadata?.oa_account_id ||
        session?.subscription?.metadata?.oa_account_id ||
        '';
    return normalizeAccountId(
        stored ||
        metadataAccountId
    );
}

function findEmailByInvoice(invoice) {
    const customerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;
    const accountId = findAccountIdByInvoice(invoice);
    const existingEmail = (accountId ? findBillingEmailByAccountId(accountId) : '') ||
        findEmailByCustomerId(customerId);
    if (existingEmail) return existingEmail;
    return normalizeEmail(
        invoice.customer_email ||
        invoice.customer_details?.email ||
        invoice.customer?.email ||
        ''
    );
}

function findAccountIdByInvoice(invoice) {
    const customerId = typeof invoice?.customer === 'string'
        ? invoice.customer
        : invoice?.customer?.id;
    return normalizeAccountId(
        findAccountIdByCustomerId(customerId) ||
        invoice?.subscription_details?.metadata?.oa_account_id ||
        invoice?.parent?.subscription_details?.metadata?.oa_account_id ||
        invoice?.metadata?.oa_account_id ||
        ''
    );
}

function findBillingEmailByAccountId(accountId) {
    const normalized = normalizeAccountId(accountId);
    return normalized ? normalizeEmail(store.accounts?.[normalized]?.billingEmail || '') : '';
}

function buildTicketLinkUrl(code) {
    const url = new URL(APP_URL);
    url.pathname = '/';
    url.search = '';
    url.searchParams.set('tickets', code);
    url.hash = '';
    return url.toString();
}

function logTicketEmail({ to, subject, ticketUrl, ticketCount }) {
    console.log('');
    console.log('[Billing email demo]');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Tickets: ${ticketCount}`);
    console.log(`Link: ${ticketUrl}`);
    console.log('');
}

function generateTicketCode() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = crypto.randomBytes(12).toString('hex');
        if (!store.ticketLinks[code]) return code;
    }
    throw new Error('Unable to generate a unique ticket link code.');
}

function demoUserId(email) {
    return crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
}

function accountUserId(accountId) {
    return crypto.createHash('sha256').update(`account:${normalizeAccountId(accountId)}`).digest('hex').slice(0, 16);
}

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeAccountId(accountId) {
    return typeof accountId === 'string' ? accountId.trim().replace(/\s+/g, '') : '';
}

function getDemoAccountSession(req) {
    return normalizeAccountId(req?.headers?.[DEMO_ACCOUNT_HEADER] || '');
}

function normalizeInvoiceOverride(value) {
    if (!value) return { email: '', accountId: '' };
    if (typeof value === 'string') {
        return { email: normalizeEmail(value), accountId: '' };
    }
    return {
        email: normalizeEmail(value.email),
        accountId: normalizeAccountId(value.accountId || value.account_id)
    };
}

function normalizeTicketCode(code) {
    return typeof code === 'string' ? code.trim().replace(/[\s-]+/g, '').toLowerCase() : '';
}

function isConfigured(value, prefix) {
    return typeof value === 'string' &&
        value.startsWith(prefix) &&
        !value.includes('REPLACE_ME');
}

async function sendSmtpMail({ to, from, subject, text }) {
    const fromAddress = extractEmailAddress(from);
    const toAddress = extractEmailAddress(to);
    if (!fromAddress || !toAddress) {
        throw new Error('SMTP delivery requires valid from and to addresses.');
    }
    if (!SMTP_SECURE) {
        throw new Error('Only implicit TLS SMTP is supported by the demo mailer. Use SMTP_PORT=465 or omit SMTP config.');
    }

    const socket = tls.connect({
        host: SMTP_HOST,
        port: SMTP_PORT,
        servername: SMTP_HOST
    });
    const timeoutMs = Number.isFinite(SMTP_TIMEOUT_MS) && SMTP_TIMEOUT_MS > 0
        ? SMTP_TIMEOUT_MS
        : 10000;
    socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error('SMTP delivery timed out.'));
    });

    let buffer = '';
    const readResponse = () => new Promise((resolve, reject) => {
        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split(/\r?\n/).filter(Boolean);
            const lastLine = lines[lines.length - 1] || '';
            if (/^\d{3} /.test(lastLine)) {
                cleanup();
                const response = buffer;
                buffer = '';
                resolve(response);
            }
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('error', onError);
        };
        socket.on('data', onData);
        socket.on('error', onError);
    });

    const expect = async (prefixes) => {
        const response = await readResponse();
        const accepted = Array.isArray(prefixes) ? prefixes : [prefixes];
        if (!accepted.some(prefix => response.startsWith(prefix))) {
            throw new Error(`SMTP server rejected command: ${response.trim()}`);
        }
        return response;
    };
    const command = async (line, prefixes = '250') => {
        socket.write(`${line}\r\n`);
        return expect(prefixes);
    };

    try {
        await expect('220');
        await command('EHLO localhost');
        if (SMTP_USER || SMTP_PASS) {
            await command('AUTH LOGIN', '334');
            await command(Buffer.from(SMTP_USER).toString('base64'), '334');
            await command(Buffer.from(SMTP_PASS).toString('base64'), '235');
        }
        await command(`MAIL FROM:<${fromAddress}>`);
        await command(`RCPT TO:<${toAddress}>`, ['250', '251']);
        await command('DATA', '354');
        socket.write(`${buildEmailMessage({ to, from, subject, text })}\r\n.\r\n`);
        await expect('250');
        await command('QUIT', '221');
    } finally {
        socket.end();
    }
}

function buildEmailMessage({ to, from, subject, text }) {
    return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${sanitizeEmailHeader(subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        String(text || '').replace(/\r?\n/g, '\r\n')
    ].join('\r\n');
}

function sanitizeEmailHeader(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function extractEmailAddress(value) {
    const text = String(value || '').trim();
    const bracketMatch = text.match(/<([^>]+)>/);
    return normalizeEmail(bracketMatch ? bracketMatch[1] : text);
}

function readJson(req) {
    return readRaw(req).then(raw => raw ? JSON.parse(raw) : {});
}

function readRaw(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,stripe-signature,x-oa-demo-account-id',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Content-Type': 'application/json'
    });
    if (status === 204) {
        res.end();
        return;
    }
    res.end(JSON.stringify(payload, null, 2));
}

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) continue;
        process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
}

function parsePositiveInt(value, fallback = 0) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadStore() {
    if (!fs.existsSync(STORE_PATH)) {
        return {
            accounts: {},
            customers: {},
            entitlements: {},
            claims: {},
            checkoutSessions: {},
            pendingInvoices: {},
            ticketLinks: {},
            stripeEvents: {}
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return {
            accounts: parsed.accounts || {},
            customers: parsed.customers || {},
            entitlements: parsed.entitlements || {},
            claims: parsed.claims || {},
            checkoutSessions: parsed.checkoutSessions || {},
            pendingInvoices: parsed.pendingInvoices || {},
            ticketLinks: parsed.ticketLinks || {},
            stripeEvents: parsed.stripeEvents || {}
        };
    } catch (error) {
        console.warn('Failed to read billing demo store; starting with an empty store.', error);
        return {
            accounts: {},
            customers: {},
            entitlements: {},
            claims: {},
            checkoutSessions: {},
            pendingInvoices: {},
            ticketLinks: {},
            stripeEvents: {}
        };
    }
}

function saveStore() {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}
