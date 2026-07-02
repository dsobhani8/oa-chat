import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildTicketExportPayload,
    default as billingClient,
    getMissingStripeConfig,
    isBillingEmailValid,
    normalizeBillingAccountId,
    normalizeBillingEmail
} from '../../chat/services/billingClient.js';

test('buildTicketExportPayload uses import-compatible ticket shape', () => {
    const payload = buildTicketExportPayload([
        { finalized_ticket: 'ticket_one' },
        { ignored: true },
        { finalized_ticket: 'ticket_two', source: 'stripe-subscription' }
    ], { ticketMode: 'production' });

    assert.equal(payload.exportType, 'tickets');
    assert.equal(payload.data.tickets.active.length, 2);
    assert.deepEqual(payload.data.tickets.archived, []);
    assert.equal(payload.data.tickets.active[0].finalized_ticket, 'ticket_one');
    assert.equal(payload.source.mode, 'production');
});

test('getMissingStripeConfig accepts premium or legacy starter price flags', () => {
    assert.deepEqual(getMissingStripeConfig({
        stripeSecretKey: true,
        webhookSecret: true,
        premiumPriceId: true
    }), []);

    assert.deepEqual(getMissingStripeConfig({
        stripeSecretKey: true,
        webhookSecret: true,
        starterPriceId: true
    }), []);

    assert.deepEqual(getMissingStripeConfig({
        stripeSecretKey: true,
        webhookSecret: false,
        premiumPriceId: false
    }), ['webhook secret', 'price ID']);
});

test('billing email normalization is conservative', () => {
    assert.equal(normalizeBillingEmail('  Alice@Example.COM  '), 'alice@example.com');
    assert.equal(isBillingEmailValid('alice@example.com'), true);
    assert.equal(isBillingEmailValid('not-an-email'), false);
});

test('billing account checkout calls account-bound product endpoints', async () => {
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: url.pathname, search: url.search, body });
        return jsonResponse({ url: 'https://checkout.stripe.test/session' });
    });

    try {
        assert.equal(normalizeBillingAccountId(' 1234 5678 '), '12345678');
        await billingClient.getAccountStatus(' 1234 5678 ');
        await billingClient.checkoutSubscriptionForAccount(' 1234 5678 ');
        await billingClient.checkoutTopupForAccount(' 1234 5678 ');
        await billingClient.portalForAccount(' 1234 5678 ');

        assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
            'GET /api/billing/status?account_id=12345678',
            'POST /api/billing/checkout-subscription',
            'POST /api/billing/checkout-topup',
            'POST /api/billing/portal'
        ]);
        assert.deepEqual(calls.slice(1).map(call => call.body), [
            { account_id: '12345678' },
            { account_id: '12345678' },
            { account_id: '12345678' }
        ]);
    } finally {
        restoreFetch();
    }
});

test('billing current account calls use local account session header without body account ids', async () => {
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({
            method,
            path: url.pathname,
            search: url.search,
            body,
            accountHeader: options.headers?.['X-OA-Demo-Account-ID']
        });
        if (url.pathname === '/api/billing/tickets/claim') {
            return jsonResponse({
                ticket_mode: 'demo',
                signed_blinded_responses: [{ index: 0, signed_blinded_response: 'signed-one' }],
                status: { claimableTickets: 0 }
            });
        }
        return jsonResponse({ url: 'https://checkout.stripe.test/session' });
    });

    try {
        await billingClient.getCurrentAccountStatus(' 1234 5678 ');
        await billingClient.checkoutForCurrentAccount(' 1234 5678 ');
        await billingClient.portalForCurrentAccount(' 1234 5678 ');
        await billingClient.claimCurrentAccountTickets(' 1234 5678 ', ['blind-one']);

        assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
            'GET /api/billing/status',
            'POST /api/billing/checkout',
            'POST /api/billing/portal',
            'POST /api/billing/tickets/claim'
        ]);
        assert.deepEqual(calls.map(call => call.accountHeader), [
            '12345678',
            '12345678',
            '12345678',
            '12345678'
        ]);
        assert.deepEqual(calls.map(call => call.body), [
            null,
            {},
            {},
            { blinded_requests: ['blind-one'] }
        ]);
    } finally {
        restoreFetch();
    }
});

test('billing client supports email top-up and checkout-session claims', async () => {
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: url.pathname, search: url.search, body });
        if (url.pathname === '/api/billing/checkout-session/claim') {
            return jsonResponse({ pending: true });
        }
        return jsonResponse({ url: 'https://checkout.stripe.test/session' });
    });

    try {
        await billingClient.checkoutTopup(' Alice@Example.COM ');
        await billingClient.claimCheckoutSession(' cs_test_123 ', ['blind-one']);

        assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
            'POST /api/billing/topup',
            'POST /api/billing/checkout-session/claim'
        ]);
        assert.deepEqual(calls.map(call => call.body), [
            { email: 'alice@example.com' },
            { session_id: 'cs_test_123', blinded_requests: ['blind-one'] }
        ]);
    } finally {
        restoreFetch();
    }
});

test('billing client stores and clears hidden demo account email', () => {
    const restore = installLocalStorageMock();
    try {
        assert.equal(billingClient.setStoredEmail(' Alice@Example.COM '), 'alice@example.com');
        assert.equal(billingClient.getStoredEmail(), 'alice@example.com');
        billingClient.clearStoredEmail();
        assert.equal(billingClient.getStoredEmail(), '');
    } finally {
        restore();
    }
});

test('billing client creates hidden demo account when local identity is new', async () => {
    const restoreStorage = installLocalStorageMock();
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: url.pathname, body });

        if (method === 'GET' && url.pathname === '/api/billing/status') {
            return jsonResponse({ accountExists: false });
        }
        if (method === 'POST' && url.pathname === '/api/billing/account') {
            return jsonResponse({
                email: body.email,
                accountExists: true,
                status: { accountExists: true, email: body.email }
            });
        }
        return jsonResponse({ error: 'unexpected request' }, false);
    });

    try {
        const result = await billingClient.ensureDemoAccount();
        assert.match(result.email, /^demo-[a-f0-9]{16}@example\.com$/);
        assert.equal(result.created, true);
        assert.equal(result.status.accountExists, true);
        assert.equal(billingClient.getStoredEmail(), result.email);
        assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
            'GET /api/billing/status',
            'POST /api/billing/account'
        ]);
        assert.equal(calls[1].body.email, result.email);
    } finally {
        restoreFetch();
        restoreStorage();
    }
});

test('billing client treats legacy status without accountExists as usable', async () => {
    const restoreStorage = installLocalStorageMock();
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: url.pathname, body });

        if (method === 'GET' && url.pathname === '/api/billing/status') {
            return jsonResponse({
                email: url.searchParams.get('email'),
                userId: 'legacy-user',
                subscription: null,
                claimableTickets: 0
            });
        }
        return jsonResponse({ error: 'unexpected request' }, false);
    });

    try {
        const result = await billingClient.ensureDemoAccount();
        assert.equal(result.created, false);
        assert.equal(result.status.userId, 'legacy-user');
        assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
            'GET /api/billing/status'
        ]);
    } finally {
        restoreFetch();
        restoreStorage();
    }
});

test('billing client fails closed when hidden demo account identity cannot persist', async () => {
    const cases = [
        { throwOnSet: true },
        { noopSet: true }
    ];

    for (const options of cases) {
        const restoreStorage = installLocalStorageMock(options);
        const calls = [];
        const restoreFetch = installFetchMock(async (url, options = {}) => {
            calls.push({ url, options });
            return jsonResponse({ accountExists: true });
        });

        try {
            await assert.rejects(
                () => billingClient.ensureDemoAccount(),
                /Unable to persist billing account identity/
            );
            assert.equal(calls.length, 0);
        } finally {
            restoreFetch();
            restoreStorage();
            billingClient.clearStoredEmail();
        }
    }
});

test('production billing claims reject server-provided finalized tickets', async () => {
    await assert.rejects(
        billingClient.buildTicketPayloadFromClaim({
            requests: [],
            claimResponse: {
                ticket_mode: 'production',
                finalized_tickets: [{ finalized_ticket: 'server_knows_this_ticket' }]
            },
            status: null
        }),
        /finalized in the browser/
    );
});

test('production billing claims reject finalized tickets inside signed responses', async () => {
    await assert.rejects(
        billingClient.buildTicketPayloadFromClaim({
            requests: [{ token: 'local-token', blindedRequest: 'blind-one' }],
            claimResponse: {
                ticket_mode: 'production',
                signed_blinded_responses: [{ index: 0, finalized_ticket: 'server_knows_this_ticket' }]
            },
            status: null
        }),
        /must not include server-provided finalized ticket IDs/
    );
});

test('production billing claims fail closed until real finalization is wired', async () => {
    await assert.rejects(
        billingClient.buildTicketPayloadFromClaim({
            requests: [{ token: 'local-token', blindedRequest: 'blind-one' }],
            claimResponse: {
                ticket_mode: 'production',
                signed_blinded_responses: [{ index: 0, signed_blinded_response: 'signed-one' }]
            },
            status: null
        }),
        /real Privacy Pass finalization/
    );
});

test('demo billing claims finalize into ticket export payloads in the browser', async () => {
    const result = await billingClient.buildTicketPayloadFromClaim({
        requests: [{ token: 'local-token', blindedRequest: 'blind-one' }],
        claimResponse: {
            ticket_mode: 'demo',
            signed_blinded_responses: [{ index: 0, signed_blinded_response: 'signed-one' }],
            allocations: [{
                ticketsIssued: 1,
                entitlementId: 'entitlement-one',
                planId: 'premium',
                planName: 'Premium',
                stripeInvoiceId: 'in_test'
            }]
        },
        status: null
    });

    assert.equal(result.ticketMode, 'demo');
    assert.equal(result.payload.exportType, 'tickets');
    assert.equal(result.payload.source.mode, 'demo');
    assert.deepEqual(result.payload.data.tickets.archived, []);
    assert.equal(result.payload.data.tickets.active.length, 1);
    assert.match(result.payload.data.tickets.active[0].finalized_ticket, /^demo_/);
    assert.equal(result.payload.data.tickets.active[0].source, undefined);
    assert.equal(result.payload.data.tickets.active[0].billing_entitlement_id, undefined);
    assert.equal(result.payload.data.tickets.active[0].billing_plan_id, undefined);
    assert.equal(result.payload.data.tickets.active[0].billing_invoice_id, undefined);
});

test('billing client redeems current account entitlements into local demo tickets', async () => {
    const restoreStorage = installLocalStorageMock();
    const downloads = [];
    const restoreDownload = installDownloadMock(downloads);
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({
            method,
            path: url.pathname,
            body,
            accountHeader: options.headers?.['X-OA-Demo-Account-ID']
        });

        if (method === 'GET' && url.pathname === '/api/billing/status') {
            return jsonResponse({
                accountId: '12345678',
                subscription: { status: 'active' },
                claimableTickets: 4,
                unclaimedTickets: 4,
                nextClaimableTickets: 2
            });
        }
        if (method === 'POST' && url.pathname === '/api/billing/tickets/claim') {
            assert.equal(body.account_id, undefined);
            assert.equal(body.email, undefined);
            assert.equal(body.blinded_requests.length, 2);
            return jsonResponse({
                ticket_mode: 'demo',
                signed_blinded_responses: [
                    { index: 0, signed_blinded_response: 'signed-one' },
                    { index: 1, signed_blinded_response: 'signed-two' }
                ],
                status: {
                    accountId: '12345678',
                    subscription: { status: 'active' },
                    claimableTickets: 0,
                    unclaimedTickets: 0
                }
            });
        }
        return jsonResponse({ error: 'unexpected request' }, false, 404);
    });

    try {
        const result = await billingClient.redeemCurrentAccountTickets('1234 5678');

        assert.equal(result.tickets.length, 2);
        assert.equal(billingClient.getDemoTicketCount(), 2);
        assert.equal(billingClient.getPendingAccountTicketClaim('12345678'), null);
        assert.equal(downloads.length, 1);
        assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
            'GET /api/billing/status',
            'POST /api/billing/tickets/claim'
        ]);
        assert.deepEqual(calls.map(call => call.accountHeader), ['12345678', '12345678']);
    } finally {
        restoreFetch();
        restoreDownload();
        restoreStorage();
    }
});

test('billing client aborts current account ticket writes after local reset', async () => {
    const restoreStorage = installLocalStorageMock();
    const downloads = [];
    const restoreDownload = installDownloadMock(downloads);
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        if (method === 'POST' && url.pathname === '/api/billing/tickets/claim') {
            assert.equal(body.blinded_requests.length, 2);
            return jsonResponse({
                ticket_mode: 'demo',
                signed_blinded_responses: [
                    { index: 0, signed_blinded_response: 'signed-one' },
                    { index: 1, signed_blinded_response: 'signed-two' }
                ],
                status: {
                    accountId: '12345678',
                    subscription: { status: 'active' },
                    claimableTickets: 0,
                    unclaimedTickets: 0,
                    nextClaimableTickets: 0
                }
            });
        }
        return jsonResponse({ error: 'unexpected request' }, false, 404);
    });

    try {
        await assert.rejects(
            () => billingClient.redeemCurrentAccountTickets('1234 5678', {
                status: {
                    accountId: '12345678',
                    subscription: { status: 'active' },
                    claimableTickets: 2,
                    unclaimedTickets: 2,
                    nextClaimableTickets: 2
                },
                shouldAbort: () => true
            }),
            /cancelled/
        );
        assert.equal(billingClient.getDemoTicketCount(), 0);
        assert.equal(downloads.length, 0);
    } finally {
        restoreFetch();
        restoreDownload();
        restoreStorage();
    }
});

test('billing client redeems subscription ticket links into demo ticket JSON', async () => {
    const restoreStorage = installLocalStorageMock();
    const downloads = [];
    const restoreDownload = installDownloadMock(downloads);
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: url.pathname, body });

        if (method === 'GET' && url.pathname === '/api/ticket-links/abc123') {
            return jsonResponse({
                type: 'subscription_ticket_link',
                ticket_count: 2,
                ticket_mode: 'demo'
            });
        }
        if (method === 'POST' && url.pathname === '/api/ticket-links/abc123/claim') {
            assert.equal(body.email, undefined);
            assert.equal(body.blinded_requests.length, 2);
            return jsonResponse({
                ticket_mode: 'demo',
                signed_blinded_responses: [
                    { index: 0, signed_blinded_response: 'signed-one' },
                    { index: 1, signed_blinded_response: 'signed-two' }
                ],
                allocations: [{
                    ticketsIssued: 2,
                    entitlementId: 'entitlement-one',
                    planId: 'premium',
                    planName: 'Premium',
                    stripeInvoiceId: 'in_test'
                }]
            });
        }
        return jsonResponse({ error: 'unexpected request' }, false, 404);
    });

    try {
        const result = await billingClient.redeemTicketLink('abc123');

        assert.equal(result.tickets.length, 2);
        assert.equal(result.payload.exportType, 'tickets');
        assert.equal(result.payload.data.tickets.active.length, 2);
        assert.equal(billingClient.getDemoTicketCount(), 2);
        assert.equal(billingClient.getPendingTicketLinkClaim('abc123'), null);
        assert.equal(downloads.length, 1);
        assert.match(downloads[0].download, /^oa-chat-subscription-tickets-/);
        assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
            'GET /api/ticket-links/abc123',
            'POST /api/ticket-links/abc123/claim'
        ]);
    } finally {
        restoreFetch();
        restoreDownload();
        restoreStorage();
    }
});

test('billing client stores checkout email only after session claim succeeds', async () => {
    const restoreStorage = installLocalStorageMock();
    const downloads = [];
    const restoreDownload = installDownloadMock(downloads);
    const calls = [];
    const restoreFetch = installFetchMock(async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path: url.pathname, search: url.search, body });

        if (method === 'GET' && url.pathname === '/api/billing/checkout-session') {
            assert.equal(url.searchParams.get('session_id'), 'cs_test_session');
            return jsonResponse({
                sessionId: 'cs_test_session',
                status: 'completed',
                checkoutType: 'subscription',
                ticketCount: 2
            });
        }
        if (method === 'POST' && url.pathname === '/api/billing/checkout-session/claim') {
            assert.equal(body.session_id, 'cs_test_session');
            assert.equal(body.blinded_requests.length, 2);
            return jsonResponse({
                ticket_mode: 'demo',
                ticket_link: undefined,
                session: {
                    sessionId: 'cs_test_session',
                    status: 'completed',
                    checkoutType: 'subscription',
                    email: 'buyer@example.com',
                    billingEmail: 'buyer@example.com',
                    ticketCount: 2
                },
                signed_blinded_responses: [
                    { index: 0, signed_blinded_response: 'signed-one' },
                    { index: 1, signed_blinded_response: 'signed-two' }
                ],
                allocations: [{
                    ticketsIssued: 2,
                    entitlementId: 'entitlement-one',
                    planId: 'premium',
                    planName: 'Premium',
                    stripeInvoiceId: 'in_test'
                }]
            });
        }
        return jsonResponse({ error: 'unexpected request' }, false, 404);
    });

    try {
        const result = await billingClient.redeemCheckoutSession('cs_test_session');

        assert.equal(result.tickets.length, 2);
        assert.equal(result.session.email, 'buyer@example.com');
        assert.equal(billingClient.getStoredEmail(), 'buyer@example.com');
        assert.equal(billingClient.getDemoTicketCount(), 2);
        assert.equal(downloads.length, 1);
        assert.deepEqual(calls.map(call => `${call.method} ${call.path}${call.search}`), [
            'GET /api/billing/checkout-session?session_id=cs_test_session',
            'POST /api/billing/checkout-session/claim'
        ]);
    } finally {
        restoreFetch();
        restoreDownload();
        restoreStorage();
    }
});

test('billing client replays saved ticket-link claim after redeemed status', async () => {
    const restoreStorage = installLocalStorageMock();
    const downloads = [];
    const restoreDownload = installDownloadMock(downloads);
    try {
        const pending = await billingClient.getOrCreatePendingTicketLinkClaim('abc123', 2);
        const pendingBlindedRequests = pending.requests.map(request => request.blindedRequest);
        const calls = [];
        const restoreFetch = installFetchMock(async (url, options = {}) => {
            const method = options.method || 'GET';
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({ method, path: url.pathname, body });

            if (method === 'GET' && url.pathname === '/api/ticket-links/abc123') {
                return jsonResponse({
                    type: 'subscription_ticket_link',
                    ticket_count: 2,
                    ticket_mode: 'demo',
                    redeemed: true
                });
            }
            if (method === 'POST' && url.pathname === '/api/ticket-links/abc123/claim') {
                assert.deepEqual(body.blinded_requests, pendingBlindedRequests);
                return jsonResponse({
                    ticket_mode: 'demo',
                    replayed: true,
                    signed_blinded_responses: [
                        { index: 0, signed_blinded_response: 'signed-one' },
                        { index: 1, signed_blinded_response: 'signed-two' }
                    ],
                    allocations: [{
                        ticketsIssued: 2,
                        entitlementId: 'entitlement-one',
                        planId: 'premium',
                        planName: 'Premium',
                        stripeInvoiceId: 'in_test'
                    }]
                });
            }
            return jsonResponse({ error: 'unexpected request' }, false, 404);
        });

        try {
            const result = await billingClient.redeemTicketLink('abc123');

            assert.equal(result.tickets.length, 2);
            assert.equal(billingClient.getDemoTicketCount(), 2);
            assert.equal(billingClient.getPendingTicketLinkClaim('abc123'), null);
            assert.equal(downloads.length, 1);
            assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
                'GET /api/ticket-links/abc123',
                'POST /api/ticket-links/abc123/claim'
            ]);
        } finally {
            restoreFetch();
        }
    } finally {
        restoreDownload();
        restoreStorage();
    }
});

test('billing client stores demo tickets only after storage round trip', () => {
    const restore = installLocalStorageMock();
    try {
        assert.equal(billingClient.addDemoTickets([{ finalized_ticket: 'demo_ticket_one' }]), 1);
        assert.equal(billingClient.getDemoTickets().length, 1);
        assert.equal(billingClient.addDemoTickets([{ finalized_ticket: 'demo_ticket_one' }]), 1);
        assert.equal(billingClient.getDemoTickets().length, 1);
        billingClient.clearDemoTickets();
        assert.equal(billingClient.getDemoTickets().length, 0);
    } finally {
        restore();
    }
});

test('billing client fails closed when demo ticket storage is unavailable', () => {
    for (const options of [{ throwOnSet: true }, { noopSet: true }]) {
        const restore = installLocalStorageMock(options);
        try {
            assert.throws(
                () => billingClient.addDemoTickets([{ finalized_ticket: 'demo_ticket_one' }]),
                /Unable to store demo tickets locally/
            );
        } finally {
            restore();
        }
    }
});

test('billing client stores and clears pending claim batches', async () => {
    const restore = installLocalStorageMock();
    try {
        const saved = billingClient.savePendingTicketClaim({
            email: ' Alice@Example.COM ',
            requests: [{ token: 'token-one', blindedRequest: 'blind-one' }]
        });

        assert.equal(saved.email, 'alice@example.com');
        assert.equal(billingClient.getPendingTicketClaim('alice@example.com').requests.length, 1);

        const existing = await billingClient.getOrCreatePendingTicketClaim('alice@example.com', 2);
        assert.equal(existing.requests.length, 1);

        billingClient.savePendingTicketClaim({
            email: 'bob@example.com',
            requests: [{ token: 'token-two', blindedRequest: 'blind-two' }]
        });

        billingClient.clearPendingTicketClaim('alice@example.com');
        assert.equal(billingClient.getPendingTicketClaim('alice@example.com'), null);
        assert.equal(billingClient.getPendingTicketClaim('bob@example.com').requests.length, 1);

        billingClient.clearPendingTicketClaim('bob@example.com');
        assert.equal(billingClient.getPendingTicketClaim('bob@example.com'), null);
    } finally {
        restore();
    }
});

test('billing client fails closed when pending claim storage is unavailable', async () => {
    const restore = installLocalStorageMock({ throwOnSet: true });
    try {
        assert.throws(
            () => billingClient.savePendingTicketClaim({
                email: 'alice@example.com',
                requests: [{ token: 'token-one', blindedRequest: 'blind-one' }]
            }),
            /Unable to save pending ticket claim/
        );

        await assert.rejects(
            () => billingClient.getOrCreatePendingTicketClaim('alice@example.com', 1),
            /Unable to save pending ticket claim/
        );
    } finally {
        restore();
    }
});

test('billing client verifies pending claim storage round trips', () => {
    const restore = installLocalStorageMock({ noopSet: true });
    try {
        assert.throws(
            () => billingClient.savePendingTicketClaim({
                email: 'alice@example.com',
                requests: [{ token: 'token-one', blindedRequest: 'blind-one' }]
            }),
            /Unable to save pending ticket claim/
        );
    } finally {
        restore();
    }
});

function installLocalStorageMock(options = {}) {
    const original = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            if (options.throwOnSet) {
                throw new Error('storage unavailable');
            }
            if (options.noopSet) {
                return;
            }
            values.set(key, String(value));
        },
        removeItem(key) {
            values.delete(key);
        }
    };

    return () => {
        if (original === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = original;
        }
    };
}

function installFetchMock(handler) {
    const original = globalThis.fetch;
    globalThis.fetch = (input, options) => handler(new URL(String(input)), options);
    return () => {
        if (original === undefined) {
            delete globalThis.fetch;
        } else {
            globalThis.fetch = original;
        }
    };
}

function installDownloadMock(downloads) {
    const originalDocument = globalThis.document;
    const originalCreateObjectUrl = globalThis.URL.createObjectURL;
    const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;

    globalThis.URL.createObjectURL = () => 'blob:download';
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.document = {
        body: {
            appendChild() {},
            removeChild() {}
        },
        createElement(tagName) {
            if (tagName === 'a') {
                return {
                    href: '',
                    download: '',
                    click() {
                        downloads.push({ href: this.href, download: this.download });
                    }
                };
            }
            return { textContent: '', innerHTML: '' };
        }
    };

    return () => {
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
        if (originalCreateObjectUrl === undefined) {
            delete globalThis.URL.createObjectURL;
        } else {
            globalThis.URL.createObjectURL = originalCreateObjectUrl;
        }
        if (originalRevokeObjectUrl === undefined) {
            delete globalThis.URL.revokeObjectURL;
        } else {
            globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
        }
    };
}

function jsonResponse(data, ok = true, status = ok ? 200 : 500) {
    return {
        ok,
        status,
        json: async () => data
    };
}
