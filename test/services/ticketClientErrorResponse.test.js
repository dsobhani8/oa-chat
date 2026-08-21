import test from 'node:test';
import assert from 'node:assert/strict';

const previousWindow = globalThis.window;
globalThis.window = {
    location: { hostname: '127.0.0.1' },
    dispatchEvent: () => {},
    addEventListener: () => {}
};

const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
const { default: ticketClient } = await import('../../chat/services/ticketClient.js');

test.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
});

async function withEmptyErrorResponse(run) {
    const originalFetch = networkProxy.fetchWithRetryJson;
    const originalConsumeTickets = ticketClient.ticketStore.consumeTickets;
    const tickets = [{
        blinded_request: 'blinded',
        signed_response: 'signed',
        finalized_ticket: 'finalized'
    }];

    networkProxy.fetchWithRetryJson = async () => ({
        response: { ok: false, status: 502 },
        data: null
    });
    ticketClient.ticketStore.consumeTickets = async (_count, operation) => ({
        tickets,
        result: await operation({ tickets, totalCount: 1, remainingCount: 0 })
    });

    try {
        await run();
    } finally {
        networkProxy.fetchWithRetryJson = originalFetch;
        ticketClient.ticketStore.consumeTickets = originalConsumeTickets;
    }
}

test('ordinary key requests handle an empty non-success response body', async () => {
    await withEmptyErrorResponse(async () => {
        await assert.rejects(
            ticketClient.requestApiKey(1),
            error => error?.message === 'Failed to request API key (502)'
        );
    });
});

test('confidential key requests handle an empty non-success response body', async () => {
    await withEmptyErrorResponse(async () => {
        await assert.rejects(
            ticketClient.requestConfidentialApiKey(1),
            error => error?.message === 'Failed to request confidential API key (502)'
        );
    });
});
