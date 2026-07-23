import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { publicVerif } from '../chat/vendor/privacypass-ts/privacypass-ts.min.js';

const HOST = process.env.BILLING_SERVER_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.BILLING_SERVER_PORT || '4242', 10);
const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');
const STORE_PATH = process.env.BILLING_DEMO_STORE ||
    path.join(os.tmpdir(), 'oa-chat-billing-demo-store.json');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PREMIUM_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID || process.env.STRIPE_STARTER_PRICE_ID || '';
const PREMIUM_TICKETS_PER_PERIOD = 500;
const PREMIUM_PRICE_LABEL = '$35/month';
const TICKET_KEY_PARAMS = {
    name: 'RSA-PSS',
    hash: 'SHA-384',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1])
};

let store = await loadStore();
let ticketIssuerCache = null;

function createEmptyStore() {
    return {
        accounts: {},
        customers: {},
        checkoutSessions: {},
        portalSessions: {},
        entitlements: {},
        claims: {},
        processedStripeEvents: {},
        processedInvoiceLines: {},
        pendingInvoices: {},
        ticketIssuer: null
    };
}

async function loadStore() {
    try {
        const parsed = JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
        return {
            ...createEmptyStore(),
            ...parsed,
            accounts: parsed.accounts || {},
            customers: parsed.customers || {},
            checkoutSessions: parsed.checkoutSessions || {},
            portalSessions: parsed.portalSessions || {},
            entitlements: parsed.entitlements || {},
            claims: parsed.claims || {},
            processedStripeEvents: parsed.processedStripeEvents || {},
            processedInvoiceLines: parsed.processedInvoiceLines || {},
            pendingInvoices: parsed.pendingInvoices || {},
            ticketIssuer: parsed.ticketIssuer || null
        };
    } catch {
        return createEmptyStore();
    }
}

async function saveStore() {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

async function ensureTicketIssuer() {
    if (ticketIssuerCache) return ticketIssuerCache;

    let privateKey;
    let publicKey;
    if (store.ticketIssuer?.privateJwk && store.ticketIssuer?.publicJwk) {
        privateKey = await crypto.subtle.importKey(
            'jwk',
            store.ticketIssuer.privateJwk,
            { name: 'RSA-PSS', hash: 'SHA-384' },
            true,
            ['sign']
        );
        publicKey = await crypto.subtle.importKey(
            'jwk',
            store.ticketIssuer.publicJwk,
            { name: 'RSA-PSS', hash: 'SHA-384' },
            true,
            ['verify']
        );
    } else {
        const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, {
            modulusLength: TICKET_KEY_PARAMS.modulusLength,
            publicExponent: TICKET_KEY_PARAMS.publicExponent,
            extractable: true
        });
        privateKey = keys.privateKey;
        publicKey = keys.publicKey;
        store.ticketIssuer = {
            createdAt: nowIso(),
            privateJwk: await crypto.subtle.exportKey('jwk', privateKey),
            publicJwk: await crypto.subtle.exportKey('jwk', publicKey)
        };
        await saveStore();
    }

    const publicKeyBytes = await publicVerif.getPublicKeyBytes(publicKey);
    ticketIssuerCache = {
        publicKey: b64urlEncode(publicKeyBytes),
        issuer: new publicVerif.Issuer(
            publicVerif.BlindRSAMode.PSS,
            'oa-billing-demo',
            privateKey,
            publicKey
        )
    };
    return ticketIssuerCache;
}

function nowIso() {
    return new Date().toISOString();
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function b64urlEncode(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

function b64urlDecode(value) {
    return new Uint8Array(Buffer.from(String(value || ''), 'base64url'));
}

function safeId(prefix, value, length = 24) {
    return `${prefix}_${sha256Hex(value).slice(0, length)}`;
}

function sanitizeAccountId(value) {
    const accountId = String(value || '').trim();
    if (!accountId || accountId.length > 160) return '';
    return accountId.replace(/[^\w:.-]/g, '');
}

function getCookie(req, name) {
    const cookieHeader = req.headers.cookie || '';
    const cookies = cookieHeader.split(';').map(part => part.trim());
    for (const cookie of cookies) {
        const [rawName, ...rawValue] = cookie.split('=');
        if (rawName === name) return decodeURIComponent(rawValue.join('='));
    }
    return '';
}

function getAuthenticatedAccountId(req) {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
        const token = match[1].trim();
        const accountToken = token.match(/^(?:account|acct):(.+)$/i);
        if (accountToken) return sanitizeAccountId(accountToken[1]);
        const jwtAccountId = getAccountIdFromJwt(token);
        if (jwtAccountId) return jwtAccountId;
        if (token) return safeId('acct', token, 20);
    }

    const cookieAccountId = sanitizeAccountId(getCookie(req, 'oa_account_id'));
    if (cookieAccountId) return cookieAccountId;

    const demoHeader = sanitizeAccountId(req.headers['x-oa-demo-account-id']);
    if (demoHeader && isLoopbackRequest(req)) return demoHeader;

    return '';
}

function getAccountIdFromJwt(token) {
    const parts = token.split('.');
    if (parts.length < 2) return '';
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return sanitizeAccountId(payload.account_id || payload.accountId || payload.sub);
    } catch {
        return '';
    }
}

function isLoopbackHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isLoopbackRequest(req) {
    const host = String(req.headers.host || '').split(':')[0];
    return isLoopbackHostname(host);
}

function getAllowedCorsOrigin(origin) {
    if (!origin) return '';
    try {
        const originUrl = new URL(origin);
        const appOrigin = new URL(APP_URL).origin;
        if (originUrl.origin === appOrigin || isLoopbackHostname(originUrl.hostname)) {
            return originUrl.origin;
        }
    } catch {
        // Invalid Origin headers should fall through to a non-credentialed CORS response.
    }
    return '';
}

function requireAccount(req) {
    const accountId = getAuthenticatedAccountId(req);
    if (!accountId) {
        const error = new Error('Account authentication required.');
        error.status = 401;
        error.code = 'BILLING_ACCOUNT_REQUIRED';
        throw error;
    }
    return ensureAccountRecord(accountId);
}

function ensureAccountRecord(accountId) {
    if (!store.accounts[accountId]) {
        store.accounts[accountId] = {
            accountId,
            stripeCustomerId: null,
            subscription: null,
            createdAt: nowIso(),
            updatedAt: nowIso()
        };
    }
    return store.accounts[accountId];
}

function isActiveSubscription(subscription) {
    if (!subscription) return false;
    if (!['active', 'trialing'].includes(subscription.status)) return false;
    if (!subscription.currentPeriodEnd) return true;
    return Number(subscription.currentPeriodEnd) * 1000 > Date.now();
}

function getAccountEntitlements(accountId) {
    return Object.values(store.entitlements)
        .filter(entitlement => entitlement.accountId === accountId)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function getUnclaimedTicketCount(accountId) {
    return getAccountEntitlements(accountId).reduce((sum, entitlement) => {
        return sum + Math.max(0, Number(entitlement.unclaimedTickets) || 0);
    }, 0);
}

function buildStatus(account) {
    const claimableTickets = getUnclaimedTicketCount(account.accountId);
    const subscriptionActive = isActiveSubscription(account.subscription);
    const entitlements = getAccountEntitlements(account.accountId).map(entitlement => ({
        id: entitlement.id,
        totalTickets: entitlement.totalTickets,
        unclaimedTickets: entitlement.unclaimedTickets,
        claimedTickets: entitlement.claimedTickets,
        status: entitlement.status,
        createdAt: entitlement.createdAt
    }));

    return {
        accountExists: true,
        premiumActive: subscriptionActive,
        stripeCustomerExists: !!account.stripeCustomerId,
        portalAvailable: !!account.stripeCustomerId,
        claimableTickets,
        unclaimedEntitlementCount: entitlements.filter(entitlement => entitlement.unclaimedTickets > 0).length,
        subscription: account.subscription || null,
        plan: {
            id: 'premium',
            name: 'Premium',
            priceLabel: PREMIUM_PRICE_LABEL,
            ticketsPerPeriod: PREMIUM_TICKETS_PER_PERIOD
        },
        entitlements
    };
}

function buildAppReturnUrl(params = {}) {
    const url = new URL(APP_URL);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });
    return url.toString();
}

function stripeEnabled() {
    return STRIPE_SECRET_KEY.startsWith('sk_') && !STRIPE_SECRET_KEY.includes('_local');
}

async function stripeRequest(pathname, params) {
    const response = await fetch(`https://api.stripe.com/v1${pathname}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params)
    });
    const data = await response.json();
    if (!response.ok) {
        const error = new Error(data?.error?.message || data?.message || `Stripe request failed (${response.status})`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

async function ensureStripeCustomer(account) {
    if (account.stripeCustomerId) return account.stripeCustomerId;

    let customerId;
    if (stripeEnabled()) {
        const customer = await stripeRequest('/customers', {
            'metadata[account_id]': account.accountId
        });
        customerId = customer.id;
    } else {
        customerId = safeId('cus_demo', account.accountId, 24);
    }

    account.stripeCustomerId = customerId;
    account.updatedAt = nowIso();
    store.customers[customerId] = {
        accountId: account.accountId,
        createdAt: nowIso(),
        updatedAt: nowIso()
    };
    return customerId;
}

async function createCheckoutSession(account) {
    if (isActiveSubscription(account.subscription)) {
        const error = new Error('Premium is already active for this account.');
        error.status = 409;
        error.code = 'BILLING_ALREADY_ACTIVE';
        throw error;
    }

    if (!STRIPE_PREMIUM_PRICE_ID && stripeEnabled()) {
        const error = new Error('STRIPE_PREMIUM_PRICE_ID is required.');
        error.status = 500;
        error.code = 'BILLING_STRIPE_PRICE_MISSING';
        throw error;
    }

    const customerId = await ensureStripeCustomer(account);
    const successUrl = buildAppReturnUrl({ billing: 'success', session_id: '{CHECKOUT_SESSION_ID}' });
    const cancelUrl = buildAppReturnUrl({ billing: 'cancelled' });

    let session;
    if (stripeEnabled()) {
        session = await stripeRequest('/checkout/sessions', {
            mode: 'subscription',
            customer: customerId,
            client_reference_id: account.accountId,
            success_url: successUrl,
            cancel_url: cancelUrl,
            'line_items[0][price]': STRIPE_PREMIUM_PRICE_ID,
            'line_items[0][quantity]': '1',
            'metadata[account_id]': account.accountId,
            'subscription_data[metadata][account_id]': account.accountId
        });
    } else {
        const id = `cs_demo_${crypto.randomBytes(12).toString('hex')}`;
        session = {
            id,
            url: buildAppReturnUrl({ billing: 'success', session_id: id }),
            customer: customerId,
            mode: 'subscription'
        };
    }

    store.checkoutSessions[session.id] = {
        id: session.id,
        accountId: account.accountId,
        stripeCustomerId: customerId,
        url: session.url,
        status: 'open',
        createdAt: nowIso()
    };

    return {
        url: session.url,
        checkoutSessionId: session.id,
        stripeCustomerId: customerId
    };
}

async function createPortalSession(account) {
    if (!account.stripeCustomerId) {
        const error = new Error('No Stripe customer exists for this account.');
        error.status = 404;
        error.code = 'BILLING_CUSTOMER_MISSING';
        throw error;
    }

    let session;
    if (stripeEnabled()) {
        session = await stripeRequest('/billing_portal/sessions', {
            customer: account.stripeCustomerId,
            return_url: buildAppReturnUrl({ billing: 'portal' })
        });
    } else {
        const id = `bps_demo_${crypto.randomBytes(12).toString('hex')}`;
        session = {
            id,
            url: buildAppReturnUrl({ billing: 'portal', customer: account.stripeCustomerId })
        };
    }

    store.portalSessions[session.id] = {
        id: session.id,
        accountId: account.accountId,
        stripeCustomerId: account.stripeCustomerId,
        createdAt: nowIso()
    };

    return { url: session.url, portalSessionId: session.id };
}

function getInvoiceLinePriceId(line = {}) {
    return line.price?.id ||
        line.pricing?.price_details?.price ||
        line.plan?.id ||
        line.price_id ||
        '';
}

function resolveAccountIdFromInvoice(invoice = {}) {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const fromCustomer = customerId ? store.customers[customerId]?.accountId : '';
    return sanitizeAccountId(
        fromCustomer ||
        invoice.metadata?.account_id ||
        invoice.subscription_details?.metadata?.account_id ||
        invoice.lines?.data?.find(line => line.metadata?.account_id)?.metadata?.account_id ||
        ''
    );
}

function createEntitlementForInvoiceLine({ accountId, customerId, invoice, line, eventId, eventCreated }) {
    const lineId = line.id || `${getInvoiceLinePriceId(line)}:${line.period?.start || invoice.period_start || ''}`;
    const invoiceId = invoice.id || `invoice_${eventId}`;
    const lineKey = `${invoiceId}:${lineId}`;

    if (store.processedInvoiceLines[lineKey]) {
        return { created: false, entitlementId: store.processedInvoiceLines[lineKey].entitlementId };
    }

    const entitlementId = safeId('ent', `${accountId}:${lineKey}`, 24);
    store.entitlements[entitlementId] = {
        id: entitlementId,
        accountId,
        stripeCustomerId: customerId,
        stripeInvoiceId: invoiceId,
        stripeInvoiceLineId: lineId,
        stripeEventId: eventId,
        totalTickets: PREMIUM_TICKETS_PER_PERIOD,
        unclaimedTickets: PREMIUM_TICKETS_PER_PERIOD,
        claimedTickets: 0,
        status: 'unclaimed',
        createdAt: eventCreated ? new Date(eventCreated * 1000).toISOString() : nowIso(),
        updatedAt: nowIso()
    };
    store.processedInvoiceLines[lineKey] = {
        accountId,
        entitlementId,
        processedAt: nowIso()
    };

    return { created: true, entitlementId };
}

function updateSubscriptionFromInvoice(account, invoice = {}) {
    const line = invoice.lines?.data?.[0] || {};
    account.subscription = {
        id: typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id || null,
        status: 'active',
        currentPeriodStart: line.period?.start || invoice.period_start || null,
        currentPeriodEnd: line.period?.end || invoice.period_end || null,
        latestInvoiceId: invoice.id || null,
        updatedAt: nowIso()
    };
    account.updatedAt = nowIso();
}

function processInvoicePaid(event) {
    const invoice = event.data?.object || {};
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || '';
    const accountId = resolveAccountIdFromInvoice(invoice);

    if (!accountId) {
        store.pendingInvoices[invoice.id || event.id] = {
            event,
            storedAt: nowIso()
        };
        return { pending: true };
    }

    const account = ensureAccountRecord(accountId);
    if (customerId) {
        account.stripeCustomerId = account.stripeCustomerId || customerId;
        store.customers[customerId] = {
            ...(store.customers[customerId] || {}),
            accountId,
            updatedAt: nowIso()
        };
    }

    updateSubscriptionFromInvoice(account, invoice);

    const lines = Array.isArray(invoice.lines?.data) ? invoice.lines.data : [];
    let createdEntitlements = 0;
    for (const line of lines) {
        const priceId = getInvoiceLinePriceId(line);
        if (STRIPE_PREMIUM_PRICE_ID && priceId !== STRIPE_PREMIUM_PRICE_ID) {
            continue;
        }
        const result = createEntitlementForInvoiceLine({
            accountId,
            customerId,
            invoice,
            line,
            eventId: event.id,
            eventCreated: event.created
        });
        if (result.created) createdEntitlements += 1;
    }

    return { pending: false, createdEntitlements };
}

function processPendingInvoicesForCustomer(customerId, accountId) {
    for (const [key, pending] of Object.entries(store.pendingInvoices)) {
        const invoice = pending.event?.data?.object || {};
        const pendingCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
        if (pendingCustomerId !== customerId) continue;
        invoice.metadata = { ...(invoice.metadata || {}), account_id: accountId };
        processInvoicePaid(pending.event);
        delete store.pendingInvoices[key];
    }
}

function processCheckoutCompleted(event) {
    const session = event.data?.object || {};
    const accountId = sanitizeAccountId(session.client_reference_id || session.metadata?.account_id || '');
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || '';

    if (!accountId) return { ignored: true };

    const account = ensureAccountRecord(accountId);
    if (customerId) {
        account.stripeCustomerId = customerId;
        store.customers[customerId] = {
            ...(store.customers[customerId] || {}),
            accountId,
            email: session.customer_details?.email || session.customer_email || store.customers[customerId]?.email || null,
            updatedAt: nowIso()
        };
        processPendingInvoicesForCustomer(customerId, accountId);
    }

    if (session.subscription) {
        account.subscription = {
            id: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
            status: 'active',
            currentPeriodStart: null,
            currentPeriodEnd: null,
            latestInvoiceId: null,
            updatedAt: nowIso()
        };
    }
    account.updatedAt = nowIso();

    if (store.checkoutSessions[session.id]) {
        store.checkoutSessions[session.id].status = 'complete';
        store.checkoutSessions[session.id].completedAt = nowIso();
    }

    return { ignored: false };
}

function verifyStripeSignature(rawBody, signatureHeader) {
    if (!STRIPE_WEBHOOK_SECRET) return true;
    const timestampMatch = String(signatureHeader || '').match(/(?:^|,)t=(\d+)/);
    const signatures = String(signatureHeader || '').split(',')
        .map(part => part.trim())
        .filter(part => part.startsWith('v1='))
        .map(part => part.slice(3));

    if (!timestampMatch || signatures.length === 0) return false;
    const timestamp = timestampMatch[1];
    const expected = crypto
        .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

    return signatures.some(signature => {
        const expectedBuffer = Buffer.from(expected);
        const signatureBuffer = Buffer.from(signature);
        return expectedBuffer.length === signatureBuffer.length &&
            crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
    });
}

async function handleWebhook(req, res, rawBody) {
    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'])) {
        return sendJson(res, 400, { error: 'Invalid Stripe signature.' });
    }

    const event = JSON.parse(rawBody || '{}');
    if (!event.id || !event.type) {
        return sendJson(res, 400, { error: 'Invalid Stripe event.' });
    }

    if (store.processedStripeEvents[event.id]) {
        return sendJson(res, 200, { received: true, replayed: true });
    }

    let result = { ignored: true };
    if (event.type === 'checkout.session.completed') {
        result = processCheckoutCompleted(event);
    } else if (event.type === 'invoice.paid') {
        result = processInvoicePaid(event);
    }

    if (!result?.pending) {
        store.processedStripeEvents[event.id] = {
            type: event.type,
            processedAt: nowIso()
        };
    }

    await saveStore();
    return sendJson(res, 200, { received: true, ...result });
}

function normalizeClaimRequests(input) {
    if (!Array.isArray(input)) return [];
    return input.map((entry, index) => {
        if (Array.isArray(entry)) {
            return [Number.isFinite(Number(entry[0])) ? Number(entry[0]) : index, String(entry[1] || '')];
        }
        if (entry && typeof entry === 'object') {
            return [
                Number.isFinite(Number(entry.index)) ? Number(entry.index) : index,
                String(entry.blindedRequest || entry.blinded_request || '')
            ];
        }
        return [index, String(entry || '')];
    }).filter(([, blindedRequest]) => blindedRequest);
}

function findSpendableEntitlement(accountId, ticketCount) {
    return getAccountEntitlements(accountId).find(entitlement => {
        return Math.max(0, Number(entitlement.unclaimedTickets) || 0) >= ticketCount;
    });
}

function buildClaimId(accountId, blindedRequests) {
    return safeId('claim', `${accountId}:${JSON.stringify(blindedRequests)}`, 32);
}

async function buildSignedResponses(blindedRequests) {
    const { issuer } = await ensureTicketIssuer();
    const signedResponses = [];

    for (const [index, blindedRequest] of blindedRequests) {
        const tokenRequest = publicVerif.TokenRequest.deserialize(
            publicVerif.BLIND_RSA,
            b64urlDecode(blindedRequest)
        );
        const response = await issuer.issue(tokenRequest);
        signedResponses.push([index, b64urlEncode(response.serialize())]);
    }

    return signedResponses;
}

async function handleTicketClaim(req, res, body) {
    const account = requireAccount(req);
    const blindedRequests = normalizeClaimRequests(body.blinded_requests);
    if (blindedRequests.length === 0) {
        return sendJson(res, 422, { error: 'blinded_requests is required.' });
    }

    const claimId = buildClaimId(account.accountId, blindedRequests);
    const existing = store.claims[claimId];
    if (existing) {
        return sendJson(res, 200, {
            ticket_mode: 'production',
            signed_responses: existing.signedResponses,
            tickets_issued: existing.ticketsIssued,
            claim_id: claimId,
            replayed: true
        });
    }

    const entitlement = findSpendableEntitlement(account.accountId, blindedRequests.length);
    if (!entitlement) {
        return sendJson(res, 402, {
            error: 'No unclaimed Premium ticket entitlement is available for this account.',
            code: 'BILLING_NO_ENTITLEMENT'
        });
    }

    let signedResponses;
    try {
        signedResponses = await buildSignedResponses(blindedRequests);
    } catch (error) {
        return sendJson(res, 422, {
            error: `Unable to sign blinded ticket requests: ${error.message}`,
            code: 'BILLING_INVALID_BLINDED_REQUESTS'
        });
    }

    entitlement.unclaimedTickets -= blindedRequests.length;
    entitlement.claimedTickets += blindedRequests.length;
    entitlement.status = entitlement.unclaimedTickets > 0 ? 'partially_claimed' : 'claimed';
    entitlement.updatedAt = nowIso();

    store.claims[claimId] = {
        id: claimId,
        accountId: account.accountId,
        entitlementId: entitlement.id,
        requestHash: sha256Hex(JSON.stringify(blindedRequests)),
        blindedRequests,
        signedResponses,
        ticketsIssued: blindedRequests.length,
        createdAt: nowIso()
    };

    await saveStore();

    return sendJson(res, 200, {
        ticket_mode: 'production',
        signed_responses: signedResponses,
        tickets_issued: blindedRequests.length,
        claim_id: claimId,
        replayed: false
    });
}

function sendCors(res) {
    const allowedOrigin = res.__oaAllowedCorsOrigin || '';
    if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-OA-Demo-Account-ID,Stripe-Signature');
}

function sendJson(res, status, data) {
    sendCors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
    const raw = await readRawBody(req);
    if (!raw) return {};
    return JSON.parse(raw);
}

async function route(req, res) {
    sendCors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
            ok: true,
            stripeConfig: {
                stripeSecretKey: !!STRIPE_SECRET_KEY,
                webhookSecret: !!STRIPE_WEBHOOK_SECRET,
                premiumPriceId: !!STRIPE_PREMIUM_PRICE_ID
            },
            plan: {
                id: 'premium',
                name: 'Premium',
                priceLabel: PREMIUM_PRICE_LABEL,
                ticketsPerPeriod: PREMIUM_TICKETS_PER_PERIOD
            }
        });
    }

    if (req.method === 'GET' && url.pathname === '/api/ticket/issue/public-key') {
        const { publicKey } = await ensureTicketIssuer();
        return sendJson(res, 200, {
            public_key: publicKey,
            ticket_mode: 'production'
        });
    }

    if (req.method === 'GET' && url.pathname === '/api/billing/status') {
        const account = requireAccount(req);
        return sendJson(res, 200, buildStatus(account));
    }

    if (req.method === 'POST' && url.pathname === '/api/billing/checkout') {
        const account = requireAccount(req);
        const result = await createCheckoutSession(account);
        await saveStore();
        return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/billing/portal') {
        const account = requireAccount(req);
        const result = await createPortalSession(account);
        await saveStore();
        return sendJson(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/billing/tickets/claim') {
        const body = await readJsonBody(req);
        return handleTicketClaim(req, res, body);
    }

    if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') {
        const rawBody = await readRawBody(req);
        return handleWebhook(req, res, rawBody);
    }

    return sendJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
    res.__oaAllowedCorsOrigin = getAllowedCorsOrigin(req.headers.origin || '');
    route(req, res).catch(async error => {
        const status = Number.isFinite(error.status) ? error.status : 500;
        if (status >= 500) {
            console.error('[Billing demo server]', error);
        }
        sendJson(res, status, {
            error: error.message || 'Billing server error.',
            code: error.code || 'BILLING_SERVER_ERROR'
        });
    });
});

server.listen(PORT, HOST, () => {
    console.log(`[Billing demo server] listening on http://${HOST}:${PORT}`);
    console.log(`[Billing demo server] store: ${STORE_PATH}`);
});
