import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WEBHOOK_SECRET = 'whsec_localtest';
const PRICE_ID = 'price_localtest';

test('billing demo server scopes subscription ticket claims per link', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const { baseUrl, storePath } = await startBillingDemoServer(t);

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_link_scope_one',
        invoiceId: 'in_link_scope_one',
        lineId: 'il_link_scope_one',
        customerId: 'cus_link_scope',
        email: 'buyer@example.com',
        accountId,
        created: 1700000001
    }));
    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_link_scope_two',
        invoiceId: 'in_link_scope_two',
        lineId: 'il_link_scope_two',
        customerId: 'cus_link_scope',
        email: 'buyer@example.com',
        accountId,
        created: 1700000002
    }));

    const issuedStore = await readStore(storePath);
    const links = Object.values(issuedStore.ticketLinks)
        .sort((a, b) => String(a.stripeInvoiceId).localeCompare(String(b.stripeInvoiceId)));
    assert.equal(links.length, 2);

    const [firstLink, secondLink] = links;
    assert.notEqual(firstLink.code, secondLink.code);
    assert.notEqual(firstLink.entitlementId, secondLink.entitlementId);

    const blindedRequests = Array.from({ length: 500 }, (_, index) => `same-blinded-request-${index}`);
    const firstClaim = await postJson(
        `${baseUrl}/api/ticket-links/${firstLink.code}/claim`,
        { blinded_requests: blindedRequests }
    );
    const secondClaim = await postJson(
        `${baseUrl}/api/ticket-links/${secondLink.code}/claim`,
        { blinded_requests: blindedRequests }
    );

    assert.notEqual(firstClaim.claim_id, secondClaim.claim_id);
    assert.equal(firstClaim.allocations[0].entitlementId, firstLink.entitlementId);
    assert.equal(secondClaim.allocations[0].entitlementId, secondLink.entitlementId);

    const replayFirstClaim = await postJson(
        `${baseUrl}/api/ticket-links/${firstLink.code}/claim`,
        { blinded_requests: blindedRequests }
    );
    assert.equal(replayFirstClaim.replayed, true);
    assert.equal(replayFirstClaim.claim_id, firstClaim.claim_id);
    assert.equal(replayFirstClaim.allocations[0].entitlementId, firstLink.entitlementId);

    const finalStore = await readStore(storePath);
    assert.equal(Object.keys(finalStore.claims).length, 2);
    assert.equal(finalStore.ticketLinks[firstLink.code].claimId, firstClaim.claim_id);
    assert.equal(finalStore.ticketLinks[secondLink.code].claimId, secondClaim.claim_id);
});

test('billing demo server retries console-fallback delivery for duplicate paid invoices', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const closedSmtpPort = await getAvailablePort();
    const { baseUrl, storePath } = await startBillingDemoServer(t, {
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(closedSmtpPort),
        SMTP_TIMEOUT_MS: '250'
    });
    const event = buildInvoicePaidEvent({
        eventId: 'evt_smtp_retry',
        invoiceId: 'in_smtp_retry',
        lineId: 'il_smtp_retry',
        customerId: 'cus_smtp_retry',
        email: 'buyer@example.com',
        accountId,
        created: 1700000003
    });

    await postSignedWebhook(baseUrl, event);
    let store = await readStore(storePath);
    let link = Object.values(store.ticketLinks)[0];
    assert.equal(link.deliveryMethod, 'console-fallback');
    assert.equal(link.deliveryAttempts, 1);

    const duplicate = await postSignedWebhook(baseUrl, event);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.deliveryRetried, true);
    assert.equal(duplicate.retriedLinks, 1);

    store = await readStore(storePath);
    link = Object.values(store.ticketLinks)[0];
    assert.equal(link.deliveryMethod, 'console-fallback');
    assert.equal(link.deliveryAttempts, 2);
});

test('billing demo server defers paid invoices without an OA account mapping', { timeout: 10000 }, async (t) => {
    const { baseUrl, storePath } = await startBillingDemoServer(t);
    const result = await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_missing_account',
        invoiceId: 'in_missing_account',
        lineId: 'il_missing_account',
        customerId: 'cus_missing_account',
        email: 'buyer@example.com',
        created: 1700000004
    }));

    assert.equal(result.deferred, true);
    const store = await readStore(storePath);
    assert.equal(Object.keys(store.entitlements).length, 0);
    assert.equal(Object.keys(store.ticketLinks).length, 0);
    assert.equal(Object.keys(store.pendingInvoices).length, 1);
    assert.equal(store.pendingInvoices.in_missing_account.accountId, '');
});

test('billing demo server creates account entitlements without billing email', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const { baseUrl, storePath } = await startBillingDemoServer(t);

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_account_without_email',
        invoiceId: 'in_account_without_email',
        lineId: 'il_account_without_email',
        customerId: 'cus_account_without_email',
        email: '',
        accountId,
        created: 1700000005
    }));

    const store = await readStore(storePath);
    const entitlement = Object.values(store.entitlements)[0];
    const link = Object.values(store.ticketLinks)[0];
    assert.equal(entitlement.accountId, accountId);
    assert.equal(entitlement.email, null);
    assert.equal(link.accountId, accountId);
    assert.equal(link.email, null);
    assert.equal(link.deliveryMethod, 'console');

    const statusResponse = await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200, JSON.stringify(status));
    assert.equal(status.billingEmail, null);
    assert.equal(status.subscription.status, 'active');
    assert.equal(status.claimableTickets, 500);
});

test('billing demo server binds Premium subscription status to account ids', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const { baseUrl, storePath } = await startBillingDemoServer(t);

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_account_subscription',
        invoiceId: 'in_account_subscription',
        lineId: 'il_account_subscription',
        customerId: 'cus_account_subscription',
        email: 'buyer@example.com',
        accountId,
        created: 1700000100
    }));

    const statusResponse = await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200, JSON.stringify(status));
    assert.equal(status.accountId, accountId);
    assert.equal(status.billingEmail, 'buyer@example.com');
    assert.equal(status.subscription.status, 'active');
    assert.equal(status.ticketsEntitled, 500);
    assert.equal(status.claimableTickets, 500);
    assert.equal(status.unclaimedTickets, 500);
    assert.equal(status.nextClaimableTickets, 500);

    const duplicateCheckout = await fetch(`${baseUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({})
    });
    const duplicateData = await duplicateCheckout.json();
    assert.equal(duplicateCheckout.status, 409, JSON.stringify(duplicateData));
    assert.match(duplicateData.error, /already linked/);

    const rejectedClaim = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ account_id: accountId, blinded_requests: ['blind-one'] })
    });
    const rejectedClaimData = await rejectedClaim.json();
    assert.equal(rejectedClaim.status, 400, JSON.stringify(rejectedClaimData));
    assert.match(rejectedClaimData.error, /only blinded requests/);

    const blindedRequests = Array.from({ length: 500 }, (_, index) => `account-blinded-${index}`);
    const claimResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const claim = await claimResponse.json();
    assert.equal(claimResponse.status, 200, JSON.stringify(claim));
    assert.equal(claim.tickets_issued, 500);
    assert.equal(claim.status.claimableTickets, 0);
    assert.equal(claim.status.unclaimedTickets, 0);

    const replayResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.tickets_issued, 500);

    const store = await readStore(storePath);
    const link = Object.values(store.ticketLinks)[0];
    assert.equal(link.accountId, accountId);
    assert.equal(link.email, 'buyer@example.com');
    assert.equal(link.ticketCount, 500);
    assert.equal(link.status, 'claimed');
    assert.equal(link.claimId, claim.claim_id);

    const linkStatusResponse = await fetch(`${baseUrl}/api/ticket-links/${link.code}`);
    const linkStatus = await linkStatusResponse.json();
    assert.equal(linkStatusResponse.status, 200, JSON.stringify(linkStatus));
    assert.equal(linkStatus.redeemed, true);
});

test('billing demo renewal is disabled unless configured', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId, {
                currentPeriodStart: new Date(Date.now() - 60 * 1000).toISOString()
            })
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);

    const statusResponse = await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });
    const status = await statusResponse.json();

    assert.equal(statusResponse.status, 200, JSON.stringify(status));
    assert.equal(status.subscription.status, 'active');
    assert.equal(status.claimableTickets, 0);
    assert.equal(Object.keys((await readStore(storePath)).entitlements).length, 0);
});

test('billing demo renewal creates one account claimable batch per elapsed period', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId, {
                currentPeriodStart: new Date(Date.now() - 35 * 1000).toISOString()
            })
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {
        BILLING_DEMO_RENEWAL_SECONDS: '30'
    }, initialStore);

    const firstStatusResponse = await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });
    const firstStatus = await firstStatusResponse.json();
    assert.equal(firstStatusResponse.status, 200, JSON.stringify(firstStatus));
    assert.equal(firstStatus.claimableTickets, 500);
    assert.equal(firstStatus.unclaimedTickets, 500);
    assert.equal(firstStatus.nextClaimableTickets, 500);
    assert.equal(firstStatus.entitlements.length, 1);
    assert.equal(firstStatus.entitlements[0].sourceType, 'subscription_demo_renewal');
    assert.equal(firstStatus.entitlements[0].ticketsEntitled, 500);

    const secondStatusResponse = await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });
    const secondStatus = await secondStatusResponse.json();
    assert.equal(secondStatusResponse.status, 200, JSON.stringify(secondStatus));
    assert.equal(secondStatus.claimableTickets, 500);
    assert.equal(secondStatus.nextClaimableTickets, 500);

    const store = await readStore(storePath);
    assert.equal(Object.keys(store.entitlements).length, 1);
    const entitlement = Object.values(store.entitlements)[0];
    assert.equal(entitlement.sourceType, 'subscription_demo_renewal');
    assert.equal(entitlement.demoRenewalIntervalSeconds, 30);
    assert.equal(entitlement.demoRenewalPeriodIndex, 1);
});

test('billing demo renewal batches claim through account blinded-request flow', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId, {
                currentPeriodStart: new Date(Date.now() - 35 * 1000).toISOString()
            })
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {
        BILLING_DEMO_RENEWAL_SECONDS: '30'
    }, initialStore);

    await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });

    const blindedRequests = Array.from({ length: 500 }, (_, index) => `renewal-blinded-${index}`);
    const claimResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const claim = await claimResponse.json();
    assert.equal(claimResponse.status, 200, JSON.stringify(claim));
    assert.equal(claim.tickets_issued, 500);
    assert.equal(claim.status.claimableTickets, 0);
    assert.equal(claim.status.unclaimedTickets, 0);

    const store = await readStore(storePath);
    const entitlement = Object.values(store.entitlements)[0];
    assert.equal(entitlement.blindTicketsIssued, 500);
    assert.equal(entitlement.status, 'active');
    assert.equal(Object.keys(store.claims).length, 1);
});

test('billing demo renewal is created only by account status checks', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId, {
                currentPeriodStart: new Date(Date.now() - 35 * 1000).toISOString()
            })
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {
        BILLING_DEMO_RENEWAL_SECONDS: '30'
    }, initialStore);

    const claimResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: ['direct-renewal-attempt'] })
    });
    const claim = await claimResponse.json();
    assert.equal(claimResponse.status, 400, JSON.stringify(claim));
    assert.match(claim.error, /No Premium ticket batch/);

    const store = await readStore(storePath);
    assert.equal(Object.keys(store.entitlements).length, 0);
});

test('billing demo renewal is not created by query account debug status', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId, {
                currentPeriodStart: new Date(Date.now() - 35 * 1000).toISOString()
            })
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {
        BILLING_DEMO_RENEWAL_SECONDS: '30'
    }, initialStore);

    const statusResponse = await fetch(`${baseUrl}/api/billing/status?account_id=${accountId}`);
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200, JSON.stringify(status));
    assert.equal(status.billingEmail, undefined);
    assert.equal(status.stripeCustomerId, undefined);
    assert.equal(status.subscription?.id, undefined);
    assert.equal(status.entitlements.some(entitlement => entitlement.id !== undefined), false);
    assert.equal(status.claimableTickets, 0);
    assert.equal(status.nextClaimableTickets, 0);

    const store = await readStore(storePath);
    assert.equal(Object.keys(store.entitlements).length, 0);
});

test('billing demo account status reports next claimable batch separately from total', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId)
        },
        entitlements: {
            first_unclaimed: {
                id: 'first_unclaimed',
                userId: 'user-first',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 500,
                blindTicketsIssued: 0,
                status: 'active',
                createdAt: '2026-07-01T00:00:00.000Z'
            },
            second_unclaimed: {
                id: 'second_unclaimed',
                userId: 'user-second',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription_demo_renewal',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 500,
                blindTicketsIssued: 0,
                status: 'active',
                createdAt: '2026-07-01T00:00:01.000Z'
            }
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);

    const statusResponse = await fetch(`${baseUrl}/api/billing/status`, {
        headers: { 'X-OA-Demo-Account-ID': accountId }
    });
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 200, JSON.stringify(status));
    assert.equal(status.claimableTickets, 1000);
    assert.equal(status.unclaimedTickets, 1000);
    assert.equal(status.nextClaimableTickets, 500);

    const blindedRequests = Array.from({ length: 500 }, (_, index) => `next-batch-${index}`);
    const claimResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const claim = await claimResponse.json();
    assert.equal(claimResponse.status, 200, JSON.stringify(claim));
    assert.equal(claim.tickets_issued, 500);
    assert.equal(claim.status.claimableTickets, 500);
    assert.equal(claim.status.unclaimedTickets, 500);
    assert.equal(claim.status.nextClaimableTickets, 500);

    const store = await readStore(storePath);
    assert.equal(store.entitlements.first_unclaimed.blindTicketsIssued, 500);
    assert.equal(store.entitlements.second_unclaimed.blindTicketsIssued, 0);
});

test('billing demo account claim replay is scoped to the entitlement', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const blindedRequests = ['reused-blinded-one', 'reused-blinded-two'];
    const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(blindedRequests))
        .digest('hex');
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId)
        },
        entitlements: {
            old_claimed: {
                id: 'old_claimed',
                userId: 'user-old',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription_demo_renewal',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 2,
                blindTicketsIssued: 2,
                status: 'active',
                createdAt: '2026-07-01T00:00:00.000Z'
            },
            new_unclaimed: {
                id: 'new_unclaimed',
                userId: 'user-new',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription_demo_renewal',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 2,
                blindTicketsIssued: 0,
                status: 'active',
                createdAt: '2026-07-01T00:00:01.000Z'
            }
        },
        claims: {
            old_claim: {
                id: 'old_claim',
                accountId,
                entitlementId: 'old_claimed',
                requestHash,
                requestCount: 2,
                signedBlindedResponses: [
                    { index: 0 },
                    { index: 1, signed_blinded_response: '' }
                ],
                ticketsIssued: 2,
                ticketMode: 'demo',
                createdAt: '2026-07-01T00:00:02.000Z'
            }
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);

    const claimResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const claim = await claimResponse.json();
    assert.equal(claimResponse.status, 200, JSON.stringify(claim));
    assert.equal(claim.replayed, false);
    assert.equal(claim.tickets_issued, 2);

    const store = await readStore(storePath);
    assert.equal(store.entitlements.new_unclaimed.blindTicketsIssued, 2);
    assert.equal(Object.keys(store.claims).length, 2);
});

test('billing demo saved account claim replays before spending new entitlement', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const blindedRequests = ['saved-retry-one', 'saved-retry-two'];
    const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(blindedRequests))
        .digest('hex');
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId)
        },
        entitlements: {
            already_claimed: {
                id: 'already_claimed',
                userId: 'user-claimed',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 2,
                blindTicketsIssued: 2,
                status: 'active',
                createdAt: '2026-07-01T00:00:00.000Z'
            },
            fresh_unclaimed: {
                id: 'fresh_unclaimed',
                userId: 'user-fresh',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription_demo_renewal',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 2,
                blindTicketsIssued: 0,
                status: 'active',
                createdAt: '2026-07-01T00:00:01.000Z'
            }
        },
        claims: {
            saved_claim: {
                id: 'saved_claim',
                accountId,
                entitlementId: 'already_claimed',
                requestHash,
                requestCount: 2,
                signedBlindedResponses: [
                    { index: 0, signed_blinded_response: 'signed-saved-one' },
                    { index: 1, signed_blinded_response: 'signed-saved-two' }
                ],
                ticketsIssued: 2,
                ticketMode: 'demo',
                createdAt: '2026-07-01T00:00:02.000Z'
            }
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);

    const replayResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.claim_id, 'saved_claim');
    assert.equal(replay.tickets_issued, 2);

    const store = await readStore(storePath);
    assert.equal(store.entitlements.fresh_unclaimed.blindTicketsIssued, 0);
    assert.equal(Object.keys(store.claims).length, 1);
});

test('billing demo incomplete exact account claim id does not shadow entitlement', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const entitlementId = 'fresh_unclaimed';
    const blindedRequests = ['incomplete-exact-one', 'incomplete-exact-two'];
    const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(blindedRequests))
        .digest('hex');
    const exactClaimId = buildAccountClaimId(accountId, entitlementId, blindedRequests);
    const initialStore = buildStore({
        accounts: {
            [accountId]: buildPremiumAccount(accountId)
        },
        entitlements: {
            [entitlementId]: {
                id: entitlementId,
                userId: 'user-fresh',
                accountId,
                email: 'buyer@example.com',
                sourceType: 'subscription_demo_renewal',
                planId: 'premium',
                planName: 'Premium',
                ticketsEntitled: 2,
                blindTicketsIssued: 0,
                status: 'active',
                createdAt: '2026-07-01T00:00:00.000Z'
            }
        },
        claims: {
            [exactClaimId]: {
                id: exactClaimId,
                accountId,
                entitlementId,
                requestHash,
                requestCount: 2,
                signedBlindedResponses: [],
                ticketsIssued: 2,
                ticketMode: 'demo',
                createdAt: '2026-07-01T00:00:01.000Z'
            }
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);

    const claimResponse = await fetch(`${baseUrl}/api/billing/tickets/claim`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({ blinded_requests: blindedRequests })
    });
    const claim = await claimResponse.json();
    assert.equal(claimResponse.status, 200, JSON.stringify(claim));
    assert.equal(claim.replayed, false);
    assert.equal(claim.claim_id, exactClaimId);
    assert.equal(claim.signed_blinded_responses.length, 2);
    assert.equal(claim.tickets_issued, 2);

    const store = await readStore(storePath);
    assert.equal(store.entitlements[entitlementId].blindTicketsIssued, 2);
    assert.equal(store.claims[exactClaimId].signedBlindedResponses.length, 2);
});

test('billing demo server requires account session for product billing routes', { timeout: 10000 }, async (t) => {
    const { baseUrl } = await startBillingDemoServer(t);

    const checkoutResponse = await fetch(`${baseUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'buyer@example.com' })
    });
    const checkout = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 401, JSON.stringify(checkout));
    assert.match(checkout.error, /Account session is required/);

    const portalResponse = await fetch(`${baseUrl}/api/billing/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'buyer@example.com' })
    });
    const portal = await portalResponse.json();
    assert.equal(portalResponse.status, 401, JSON.stringify(portal));
    assert.match(portal.error, /Account session is required/);

    const statusResponse = await fetch(`${baseUrl}/api/billing/status?email=buyer@example.com`);
    const status = await statusResponse.json();
    assert.equal(statusResponse.status, 401, JSON.stringify(status));
    assert.match(status.error, /Account session is required/);
});

test('billing demo server reuses pending account subscription checkout sessions', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const pendingUrl = 'https://checkout.stripe.com/c/pay/cs_pending_account';
    const initialStore = buildStore({
        accounts: {
            [accountId]: {
                accountId,
                pendingCheckout: {
                    sessionId: 'cs_pending_account',
                    type: 'subscription',
                    url: pendingUrl,
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    createdAt: '2026-07-01T00:00:00.000Z'
                },
                createdAt: '2026-07-01T00:00:00.000Z'
            }
        }
    });
    const { baseUrl } = await startBillingDemoServer(t, {}, initialStore);

    const response = await fetch(`${baseUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({})
    });
    const data = await response.json();

    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.url, pendingUrl);
    assert.equal(data.pendingCheckout, true);
    assert.equal(data.sessionId, 'cs_pending_account');
});

test('billing demo server serializes concurrent account subscription checkout creation', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const stripe = await startFakeStripeCheckoutServer(t, { delayMs: 100 });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {
        STRIPE_API_BASE_URL: stripe.baseUrl
    });
    const requestCheckout = () => fetch(`${baseUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-OA-Demo-Account-ID': accountId
        },
        body: JSON.stringify({})
    });

    const [firstResponse, secondResponse] = await Promise.all([
        requestCheckout(),
        requestCheckout()
    ]);
    const first = await firstResponse.json();
    const second = await secondResponse.json();

    assert.equal(firstResponse.status, 200, JSON.stringify(first));
    assert.equal(secondResponse.status, 200, JSON.stringify(second));
    assert.equal(first.url, second.url);
    assert.equal(stripe.checkoutCalls(), 1);

    const store = await readStore(storePath);
    assert.equal(Object.keys(store.checkoutSessions).length, 1);
    assert.equal(store.accounts[accountId].pendingCheckout.sessionId, 'cs_mock_checkout_1');
});

test('billing demo server links subscription claims to matching checkout subscription', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const email = 'buyer@example.com';
    const initialStore = buildStore({
        customers: {
            [email]: {
                email,
                userId: 'user-multi-session',
                stripeCustomerId: 'cus_multi_session',
                createdAt: '2026-07-01T00:00:00.000Z'
            }
        },
        checkoutSessions: {
            cs_subscription_first: {
                sessionId: 'cs_subscription_first',
                email,
                billingEmail: email,
                stripeCustomerId: 'cus_multi_session',
                stripeSubscriptionId: 'sub_first',
                checkoutType: 'subscription',
                mode: 'subscription',
                priceId: PRICE_ID,
                ticketCount: 500,
                status: 'completed',
                createdAt: '2026-07-01T00:00:00.000Z'
            },
            cs_subscription_second: {
                sessionId: 'cs_subscription_second',
                email,
                billingEmail: email,
                stripeCustomerId: 'cus_multi_session',
                stripeSubscriptionId: 'sub_second',
                checkoutType: 'subscription',
                mode: 'subscription',
                priceId: PRICE_ID,
                ticketCount: 500,
                status: 'completed',
                createdAt: '2026-07-01T00:00:01.000Z'
            }
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_subscription_first',
        invoiceId: 'in_subscription_first',
        lineId: 'il_subscription_first',
        customerId: 'cus_multi_session',
        email,
        accountId,
        subscriptionId: 'sub_first',
        created: 1700000550
    }));

    const store = await readStore(storePath);
    const link = Object.values(store.ticketLinks)[0];
    assert.equal(link.stripeSubscriptionId, 'sub_first');
    assert.equal(link.stripeCheckoutSessionId, 'cs_subscription_first');
    assert.equal(store.checkoutSessions.cs_subscription_first.ticketLinkCode, link.code);
    assert.equal(store.checkoutSessions.cs_subscription_second.ticketLinkCode, undefined);
});

test('billing demo server reads nested Stripe invoice subscription ids', { timeout: 10000 }, async (t) => {
    const accountId = '1234567890123456';
    const email = 'buyer@example.com';
    const sessionId = 'cs_nested_subscription';
    const initialStore = buildStore({
        customers: {
            [email]: {
                email,
                userId: 'user-nested-subscription',
                stripeCustomerId: 'cus_nested_subscription',
                createdAt: '2026-07-01T00:00:00.000Z'
            }
        },
        checkoutSessions: {
            [sessionId]: {
                sessionId,
                email,
                billingEmail: email,
                stripeCustomerId: 'cus_nested_subscription',
                stripeSubscriptionId: 'sub_nested_subscription',
                checkoutType: 'subscription',
                mode: 'subscription',
                priceId: PRICE_ID,
                ticketCount: 500,
                status: 'completed',
                createdAt: '2026-07-01T00:00:00.000Z'
            }
        }
    });
    const { baseUrl, storePath } = await startBillingDemoServer(t, {}, initialStore);
    const event = buildInvoicePaidEvent({
        eventId: 'evt_nested_subscription',
        invoiceId: 'in_nested_subscription',
        lineId: 'il_nested_subscription',
        customerId: 'cus_nested_subscription',
        email,
        accountId,
        subscriptionId: null,
        created: 1700000560
    });
    delete event.data.object.subscription;
    event.data.object.parent = {
        subscription_details: {
            subscription: 'sub_nested_subscription',
            metadata: {}
        }
    };

    await postSignedWebhook(baseUrl, event);

    const store = await readStore(storePath);
    const link = Object.values(store.ticketLinks)[0];
    assert.equal(store.customers[email].subscription.id, 'sub_nested_subscription');
    assert.equal(link.stripeSubscriptionId, 'sub_nested_subscription');
    assert.equal(link.stripeCheckoutSessionId, sessionId);
});

async function startBillingDemoServer(t, envOverrides = {}, initialStore = null) {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const storePath = envOverrides.BILLING_DEMO_STORE || buildStorePath();
    if (initialStore) {
        await fs.writeFile(storePath, `${JSON.stringify(initialStore, null, 2)}\n`);
    }

    let output = '';
    const server = spawn(process.execPath, ['scripts/billing-demo-server.mjs'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            APP_URL: 'http://localhost:8090',
            BILLING_DEMO_STORE: storePath,
            BILLING_SERVER_HOST: '127.0.0.1',
            BILLING_SERVER_PORT: String(port),
            STRIPE_SECRET_KEY: 'sk_test_local',
            STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
            STRIPE_PREMIUM_PRICE_ID: PRICE_ID,
            SMTP_HOST: '',
            SMTP_USER: '',
            SMTP_PASS: '',
            MAIL_FROM: '',
            ...envOverrides
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
    });
    server.stderr.on('data', chunk => {
        output += chunk.toString('utf8');
    });

    t.after(async () => {
        await stopServer(server);
        await fs.rm(storePath, { force: true });
    });

    await waitForServer(baseUrl, server, () => output);
    return { baseUrl, storePath };
}

async function startFakeStripeCheckoutServer(t, { delayMs = 0 } = {}) {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let checkoutCallCount = 0;

    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/v1/checkout/sessions') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not found' } }));
            return;
        }

        checkoutCallCount += 1;
        await readRequestBody(req);
        if (delayMs > 0) {
            await delay(delayMs);
        }

        const sessionId = `cs_mock_checkout_${checkoutCallCount}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: sessionId,
            object: 'checkout.session',
            url: `https://checkout.stripe.test/pay/${sessionId}`,
            expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60
        }));
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

    t.after(async () => {
        await new Promise(resolve => server.close(() => resolve()));
    });

    return {
        baseUrl,
        checkoutCalls: () => checkoutCallCount
    };
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function buildStorePath() {
    return path.join(
        os.tmpdir(),
        `oa-chat-billing-demo-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
}

function buildStore(overrides = {}) {
    return {
        accounts: {},
        customers: {},
        entitlements: {},
        claims: {},
        checkoutSessions: {},
        pendingInvoices: {},
        ticketLinks: {},
        stripeEvents: {},
        ...overrides
    };
}

function buildPremiumAccount(accountId, overrides = {}) {
    return {
        accountId,
        billingEmail: overrides.billingEmail || 'buyer@example.com',
        stripeCustomerId: overrides.stripeCustomerId || 'cus_demo_renewal',
        subscription: {
            id: overrides.subscriptionId || 'sub_demo_renewal',
            status: overrides.subscriptionStatus || 'active',
            currentPeriodStart: overrides.currentPeriodStart || new Date().toISOString(),
            currentPeriodEnd: overrides.currentPeriodEnd || null,
            updatedAt: overrides.updatedAt || new Date().toISOString(),
            stripeEventCreated: overrides.stripeEventCreated || 1700000000
        },
        createdAt: overrides.createdAt || new Date().toISOString()
    };
}

function buildAccountClaimId(accountId, entitlementId, blindedRequests) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({
            scope: 'account_subscription_claim',
            accountId,
            entitlementId,
            blindedRequests
        }))
        .digest('hex');
}

function buildInvoicePaidEvent({
    eventId,
    invoiceId,
    lineId,
    customerId,
    email,
    accountId,
    subscriptionId = 'sub_link_scope',
    created
}) {
    return {
        id: eventId,
        type: 'invoice.paid',
        created,
        data: {
            object: {
                id: invoiceId,
                customer: customerId,
                customer_email: email,
                subscription: subscriptionId,
                subscription_details: {
                    metadata: accountId ? { oa_account_id: accountId } : {}
                },
                period_start: created,
                period_end: created + 30 * 24 * 60 * 60,
                lines: {
                    data: [{
                        id: lineId,
                        price: { id: PRICE_ID },
                        period: {
                            start: created,
                            end: created + 30 * 24 * 60 * 60
                        }
                    }]
                }
            }
        }
    };
}

function buildCheckoutSessionCompletedEvent({
    eventId,
    sessionId,
    customerId,
    email,
    accountId,
    clientReferenceId = accountId,
    metadata = null,
    created
}) {
    return {
        id: eventId,
        type: 'checkout.session.completed',
        created,
        data: {
            object: {
                id: sessionId,
                mode: 'payment',
                payment_status: 'paid',
                customer: customerId,
                customer_details: { email },
                client_reference_id: clientReferenceId,
                metadata: metadata || {
                    ...(accountId ? { oa_account_id: accountId } : {})
                }
            }
        }
    };
}

async function postSignedWebhook(baseUrl, event) {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    const response = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': `t=${timestamp},v1=${signature}`
        },
        body
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
}

async function readStore(storePath) {
    return JSON.parse(await fs.readFile(storePath, 'utf8'));
}

async function waitForServer(baseUrl, server, getOutput) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (server.exitCode !== null) {
            throw new Error(`Billing demo server exited early:\n${getOutput()}`);
        }
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch {
            // The server may still be binding its local port.
        }
        await delay(50);
    }
    throw new Error(`Timed out waiting for billing demo server:\n${getOutput()}`);
}

function getAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : null;
            server.close(() => {
                if (port) {
                    resolve(port);
                } else {
                    reject(new Error('Unable to allocate a local test port.'));
                }
            });
        });
    });
}

function stopServer(server) {
    return new Promise(resolve => {
        if (!server || server.exitCode !== null) {
            resolve();
            return;
        }
        server.once('exit', () => resolve());
        server.kill();
        setTimeout(() => {
            if (server.exitCode === null) server.kill('SIGKILL');
        }, 1000).unref();
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
