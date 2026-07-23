import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BillingClient,
    buildTicketExportPayload,
    buildTicketPayloadFromClaim,
    getMissingStripeConfig
} from '../../chat/services/billingClient.js';

test('buildTicketExportPayload uses normal production ticket import shape', () => {
    const payload = buildTicketExportPayload([
        { finalized_ticket: 'ticket_one' },
        { ignored: true },
        { finalized_ticket: 'ticket_two', source: 'stripe-subscription' }
    ], { ticketMode: 'production' });

    assert.equal(payload.exportType, 'tickets');
    assert.equal(payload.source.mode, 'production');
    assert.equal(payload.data.tickets.active.length, 2);
    assert.deepEqual(payload.data.tickets.archived, []);
    assert.equal(payload.data.tickets.active[0].finalized_ticket, 'ticket_one');
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

test('billing client requires account auth for status, checkout, portal, and claim', async () => {
    const cases = [
        createAccountService({ accountId: null, status: 'none', sessionVerified: false }, null),
        createAccountService({ accountId: 'acct_A', status: 'locked', sessionVerified: false }, null)
    ];

    for (const accountService of cases) {
        const client = new BillingClient({
            baseUrl: 'http://billing.test',
            accountService,
            fetchImpl: async () => jsonResponse({ ok: true }),
            subscribeToAccount: false
        });

        await assert.rejects(() => client.getStatus({ force: true }), /account|Unlock/i);
        await assert.rejects(() => client.checkout(), /account|Unlock/i);
        await assert.rejects(() => client.portal(), /account|Unlock/i);
        await assert.rejects(() => client.claim([[0, 'blind-one']]), /account|Unlock/i);
    }
});

test('claim request body contains only blinded requests, not account identity', async () => {
    const calls = [];
    const client = new BillingClient({
        baseUrl: 'http://billing.test',
        accountService: createAccountService({ accountId: 'acct_A', status: 'unlocked', sessionVerified: true }, 'token-A'),
        fetchImpl: async (input, options = {}) => {
            const url = new URL(String(input));
            const body = JSON.parse(options.body);
            calls.push({ url, options, body });
            assert.equal(url.pathname, '/api/billing/tickets/claim');
            assert.equal(options.headers.Authorization, 'Bearer token-A');
            assert.equal(options.headers['X-OA-Account-ID'], undefined);
            assert.equal(options.headers['X-OA-Demo-Account-ID'], undefined);
            assert.deepEqual(body, { blinded_requests: [[0, 'blind-one'], [1, 'blind-two']] });
            assert.equal(body.account_id, undefined);
            assert.equal(body.accountId, undefined);
            assert.equal(body.entitlement_id, undefined);
            return jsonResponse({
                ticket_mode: 'production',
                signed_responses: [[0, 'signed-one'], [1, 'signed-two']],
                tickets_issued: 2
            });
        },
        subscribeToAccount: false
    });

    const result = await client.claim([[0, 'blind-one'], [1, 'blind-two']]);
    assert.equal(result.tickets_issued, 2);
    assert.equal(calls.length, 1);
});

test('production claims reject server-provided finalized tickets', async () => {
    await assert.rejects(
        buildTicketPayloadFromClaim({
            requests: [],
            claimResponse: {
                ticket_mode: 'production',
                finalized_tickets: [{ finalized_ticket: 'server_knows_this_ticket' }]
            },
            privacyPass: createPrivacyPassStub()
        }),
        /finalized in the browser/
    );
});

test('production claims reject finalized ticket IDs inside signed responses', async () => {
    await assert.rejects(
        buildTicketPayloadFromClaim({
            requests: [{ index: 0, blindedRequest: 'blind-one', state: { id: 0 } }],
            claimResponse: {
                ticket_mode: 'production',
                signed_responses: [{ index: 0, signed_response: 'signed-one', finalized_ticket: 'server_knows_this_ticket' }]
            },
            privacyPass: createPrivacyPassStub()
        }),
        /must not include server-provided finalized ticket IDs/
    );
});

test('production claims finalize signed responses locally without billing metadata', async () => {
    const result = await buildTicketPayloadFromClaim({
        requests: [
            { index: 0, blindedRequest: 'blind-one', state: { id: 'local-one' } }
        ],
        claimResponse: {
            ticket_mode: 'production',
            signed_responses: [[0, 'signed-one']]
        },
        privacyPass: createPrivacyPassStub()
    });

    assert.equal(result.ticketMode, 'production');
    assert.equal(result.tickets.length, 1);
    assert.equal(result.tickets[0].finalized_ticket, 'finalized-local-one-signed-one');
    assert.equal(result.tickets[0].source, undefined);
    assert.equal(result.tickets[0].account_id, undefined);
    assert.equal(result.tickets[0].stripe_customer_id, undefined);
    assert.equal(result.tickets[0].entitlement_id, undefined);
    assert.equal(result.tickets[0].billing_entitlement_id, undefined);
});

test('pending claim state is saved before POST and cleared only after ticket import', async () => {
    const restoreStorage = installLocalStorageMock();
    const accountService = createAccountService({ accountId: 'acct_A', status: 'unlocked', sessionVerified: true }, 'token-A');
    const importedPayloads = [];

    try {
        const client = new BillingClient({
            baseUrl: 'http://billing.test',
            accountService,
            privacyPass: createPrivacyPassStub(),
            storage: globalThis.localStorage,
            fetchImpl: async (input, options = {}) => {
                const url = new URL(String(input));
                if (url.pathname === '/api/ticket/issue/public-key') {
                    return jsonResponse({ public_key: 'public-key' });
                }
                if (url.pathname === '/api/billing/tickets/claim') {
                    assert.equal(client.getPendingTicketClaim('acct_A').requests.length, 2);
                    return jsonResponse({
                        ticket_mode: 'production',
                        signed_responses: [[0, 'signed-zero'], [1, 'signed-one']],
                        tickets_issued: 2
                    });
                }
                return jsonResponse({ error: 'unexpected request' }, false, 404);
            },
            subscribeToAccount: false
        });

        const result = await client.claimAndImportTickets(2, {
            ticketService: {
                async importTickets(payload) {
                    assert.equal(client.getPendingTicketClaim('acct_A').requests.length, 2);
                    importedPayloads.push(payload);
                }
            }
        });

        assert.equal(result.tickets.length, 2);
        assert.equal(importedPayloads.length, 1);
        assert.equal(client.getPendingTicketClaim('acct_A'), null);
    } finally {
        restoreStorage();
    }
});

test('pending claim can finalize after reload using persisted local Privacy Pass state', async () => {
    const restoreStorage = installLocalStorageMock();
    const accountService = createAccountService({ accountId: 'acct_A', status: 'unlocked', sessionVerified: true }, 'token-A');

    try {
        const firstClient = new BillingClient({
            baseUrl: 'http://billing.test',
            accountService,
            privacyPass: createPrivacyPassStub(),
            storage: globalThis.localStorage,
            fetchImpl: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === '/api/ticket/issue/public-key') {
                    return jsonResponse({ public_key: 'public-key' });
                }
                return jsonResponse({ error: 'unexpected request' }, false, 404);
            },
            subscribeToAccount: false
        });

        await firstClient.getOrCreatePendingTicketClaim(1);

        const reloadedClient = new BillingClient({
            baseUrl: 'http://billing.test',
            accountService,
            privacyPass: createPrivacyPassStub(),
            storage: globalThis.localStorage,
            fetchImpl: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === '/api/billing/tickets/claim') {
                    return jsonResponse({
                        ticket_mode: 'production',
                        signed_responses: [[0, 'signed-zero']],
                        tickets_issued: 1
                    });
                }
                return jsonResponse({ error: 'unexpected request' }, false, 404);
            },
            subscribeToAccount: false
        });

        const result = await reloadedClient.claimAndImportTickets(1, {
            ticketService: {
                async importTickets(payload) {
                    assert.equal(payload.data.tickets.active[0].finalized_ticket, 'finalized-0-signed-zero');
                }
            }
        });

        assert.equal(result.tickets.length, 1);
        assert.equal(reloadedClient.getPendingTicketClaim('acct_A'), null);
    } finally {
        restoreStorage();
    }
});

test('truncated billing claim response preserves pending recovery state', async () => {
    const restoreStorage = installLocalStorageMock();
    const accountService = createAccountService({ accountId: 'acct_A', status: 'unlocked', sessionVerified: true }, 'token-A');
    let imported = false;

    try {
        const client = new BillingClient({
            baseUrl: 'http://billing.test',
            accountService,
            privacyPass: createPrivacyPassStub(),
            storage: globalThis.localStorage,
            fetchImpl: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === '/api/ticket/issue/public-key') {
                    return jsonResponse({ public_key: 'public-key' });
                }
                if (url.pathname === '/api/billing/tickets/claim') {
                    return jsonResponse({
                        ticket_mode: 'production',
                        signed_responses: [[0, 'signed-zero']],
                        tickets_issued: 2
                    });
                }
                return jsonResponse({ error: 'unexpected request' }, false, 404);
            },
            subscribeToAccount: false
        });

        await assert.rejects(
            () => client.claimAndImportTickets(2, {
                ticketService: {
                    async importTickets() {
                        imported = true;
                    }
                }
            }),
            /incomplete signed ticket batch/
        );

        assert.equal(imported, false);
        assert.equal(client.getPendingTicketClaim('acct_A').requests.length, 2);
    } finally {
        restoreStorage();
    }
});

test('switching accounts clears cached billing UI state and hides another account pending claim', async () => {
    const restoreStorage = installLocalStorageMock();
    const accountService = createAccountService({ accountId: 'acct_A', status: 'unlocked', sessionVerified: true }, 'token-A');

    try {
        const client = new BillingClient({
            baseUrl: 'http://billing.test',
            accountService,
            storage: globalThis.localStorage,
            subscribeToAccount: false
        });

        client.statusCache = { premiumActive: true };
        client.statusAccountId = 'acct_A';
        client.savePendingTicketClaim({
            accountId: 'acct_A',
            ticketCount: 1,
            requests: [{ index: 0, blindedRequest: 'blind-A', stateKey: 'state-A', state: { id: 'A' } }]
        });

        assert.equal(client.getPendingTicketClaim().requests.length, 1);

        accountService.setState({ accountId: 'acct_B', status: 'unlocked', sessionVerified: true });
        client.handleAccountStateChange(accountService.getState());

        assert.equal(client.getCurrentStatus(), null);
        assert.equal(client.getPendingTicketClaim(), null);
        assert.equal(client.getPendingTicketClaim('acct_A').requests.length, 1);
    } finally {
        restoreStorage();
    }
});

test('production claim fails closed when local Privacy Pass state is unavailable', async () => {
    await assert.rejects(
        buildTicketPayloadFromClaim({
            requests: [{ index: 0, blindedRequest: 'blind-one' }],
            claimResponse: {
                ticket_mode: 'production',
                signed_responses: [[0, 'signed-one']]
            },
            privacyPass: createPrivacyPassStub()
        }),
        /saved local Privacy Pass state/
    );
});

function createAccountService(initialState, token) {
    let state = { ...initialState };
    return {
        getState: () => ({ ...state }),
        setState(next) {
            state = { ...state, ...next };
        },
        getAccessToken: () => token,
        refreshAccessToken: async () => !!token,
        subscribe() {
            return () => {};
        }
    };
}

function createPrivacyPassStub() {
    let counter = 0;
    return {
        async createSingleTokenRequest() {
            const id = counter;
            counter += 1;
            return {
                blindedRequest: `blind-${id}`,
                state: { id },
                serializedState: { type: 'raw-json', value: { id } }
            };
        },
        async finalizeToken(signedResponse, state) {
            return `finalized-${state.id}-${signedResponse}`;
        }
    };
}

function installLocalStorageMock() {
    const original = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
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

function jsonResponse(data, ok = true, status = ok ? 200 : 500) {
    return {
        ok,
        status,
        text: async () => JSON.stringify(data),
        json: async () => data
    };
}
