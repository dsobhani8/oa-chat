import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import privacyPassProvider from '../../chat/services/privacyPass.js';

const WEBHOOK_SECRET = 'whsec_localtest';
const PRICE_ID = 'price_localtest';

test('billing demo server maps checkout to one customer per account and blocks active duplicate checkout', { timeout: 10000 }, async (t) => {
    const { baseUrl, storePath, server, output } = await startBillingServer(t);
    const now = Math.floor(Date.now() / 1000);

    const initialStatus = await getJson(`${baseUrl}/api/billing/status`, authHeaders('acct_A'));
    assert.equal(initialStatus.premiumActive, false);
    assert.equal(initialStatus.stripeCustomerExists, false);

    const corsStatus = await fetch(`${baseUrl}/api/billing/status`, {
        headers: {
            ...authHeaders('acct_A'),
            Origin: 'http://localhost:8080'
        }
    });
    assert.equal(corsStatus.status, 200);
    assert.equal(corsStatus.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    assert.equal(corsStatus.headers.get('access-control-allow-credentials'), 'true');
    await corsStatus.json();

    const firstCheckout = await postJson(`${baseUrl}/api/billing/checkout`, {}, authHeaders('acct_A'));
    const secondCheckout = await postJson(`${baseUrl}/api/billing/checkout`, {}, authHeaders('acct_A'));
    assert.match(firstCheckout.url, /billing=success/);
    assert.match(secondCheckout.url, /billing=success/);

    let store = await readStore(storePath);
    assert.equal(Object.keys(store.customers).length, 1);
    const customerId = store.accounts.acct_A.stripeCustomerId;
    assert.ok(customerId);

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_paid_one',
        invoiceId: 'in_paid_one',
        lineId: 'il_paid_one',
        customerId,
        created: now
    }));
    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_paid_one',
        invoiceId: 'in_paid_one',
        lineId: 'il_paid_one',
        customerId,
        created: now
    }));
    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_paid_one_retry_line',
        invoiceId: 'in_paid_one',
        lineId: 'il_paid_one',
        customerId,
        created: now + 1
    }));

    store = await readStore(storePath);
    assert.equal(Object.keys(store.entitlements).length, 1);
    assert.equal(Object.keys(store.processedInvoiceLines).length, 1);

    const activeStatus = await getJson(`${baseUrl}/api/billing/status`, authHeaders('acct_A'));
    assert.equal(activeStatus.premiumActive, true);
    assert.equal(activeStatus.claimableTickets, 500);

    const duplicateCheckout = await postJson(`${baseUrl}/api/billing/checkout`, {}, authHeaders('acct_A'), 409);
    assert.equal(duplicateCheckout.code, 'BILLING_ALREADY_ACTIVE');

    assert.equal(server.exitCode, null, output());
});

test('billing demo claim spends only the authenticated account entitlement and replays saved batches', { timeout: 10000 }, async (t) => {
    const { baseUrl, storePath } = await startBillingServer(t);
    const now = Math.floor(Date.now() / 1000);

    await postJson(`${baseUrl}/api/billing/checkout`, {}, authHeaders('acct_A'));
    const storeAfterCheckout = await readStore(storePath);
    const customerId = storeAfterCheckout.accounts.acct_A.stripeCustomerId;

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_claim_one',
        invoiceId: 'in_claim_one',
        lineId: 'il_claim_one',
        customerId,
        created: now
    }));

    const keyData = await getJson(`${baseUrl}/api/ticket/issue/public-key`);
    assert.ok(keyData.public_key);

    const requestStates = [];
    const blindedRequests = [];
    for (let index = 0; index < 3; index += 1) {
        const request = await privacyPassProvider.createSingleTokenRequest(keyData.public_key);
        requestStates.push(request.state);
        blindedRequests.push([index, request.blindedRequest]);
    }

    const firstClaim = await postJson(
        `${baseUrl}/api/billing/tickets/claim`,
        { blinded_requests: blindedRequests },
        authHeaders('acct_A')
    );
    assert.equal(firstClaim.ticket_mode, 'production');
    assert.equal(firstClaim.tickets_issued, 3);
    assert.equal(firstClaim.signed_responses.length, 3);
    assert.equal(firstClaim.finalized_tickets, undefined);
    assert.equal(firstClaim.signed_responses[0][1].startsWith('signed_'), false);
    const finalized = await privacyPassProvider.finalizeToken(firstClaim.signed_responses[0][1], requestStates[0]);
    assert.ok(finalized);

    const replay = await postJson(
        `${baseUrl}/api/billing/tickets/claim`,
        { blinded_requests: blindedRequests },
        authHeaders('acct_A')
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.claim_id, firstClaim.claim_id);
    assert.deepEqual(replay.signed_responses, firstClaim.signed_responses);

    const accountBClaim = await postJson(
        `${baseUrl}/api/billing/tickets/claim`,
        { blinded_requests: blindedRequests },
        authHeaders('acct_B'),
        402
    );
    assert.equal(accountBClaim.code, 'BILLING_NO_ENTITLEMENT');

    const statusA = await getJson(`${baseUrl}/api/billing/status`, authHeaders('acct_A'));
    const statusB = await getJson(`${baseUrl}/api/billing/status`, authHeaders('acct_B'));
    assert.equal(statusA.claimableTickets, 497);
    assert.equal(statusB.claimableTickets, 0);

    const finalStore = await readStore(storePath);
    assert.equal(Object.keys(finalStore.claims).length, 1);
    assert.equal(Object.values(finalStore.entitlements)[0].claimedTickets, 3);
    assert.equal(Object.values(finalStore.entitlements)[0].unclaimedTickets, 497);
});

function buildInvoicePaidEvent({
    eventId,
    invoiceId,
    lineId,
    customerId,
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
                subscription: `sub_${invoiceId}`,
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

async function startBillingServer(t) {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const storePath = path.join(
        os.tmpdir(),
        `oa-chat-account-billing-demo-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    let outputText = '';
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
            STRIPE_PREMIUM_PRICE_ID: PRICE_ID
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stdout.on('data', chunk => {
        outputText += chunk.toString('utf8');
    });
    server.stderr.on('data', chunk => {
        outputText += chunk.toString('utf8');
    });

    t.after(async () => {
        await stopServer(server);
        await fs.rm(storePath, { force: true });
    });

    await waitForServer(baseUrl, server, () => outputText);
    return { baseUrl, storePath, server, output: () => outputText };
}

function authHeaders(accountId) {
    return {
        Authorization: `Bearer account:${accountId}`
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

async function getJson(url, headers = {}, expectedStatus = 200) {
    const response = await fetch(url, { headers });
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
    return data;
}

async function postJson(url, body, headers = {}, expectedStatus = 200) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
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
