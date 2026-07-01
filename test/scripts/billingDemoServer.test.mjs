import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const WEBHOOK_SECRET = 'whsec_localtest';
const PRICE_ID = 'price_localtest';

test('billing demo server scopes subscription ticket claims per link', { timeout: 10000 }, async (t) => {
    const port = await getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const storePath = path.join(
        os.tmpdir(),
        `oa-chat-billing-demo-test-${process.pid}-${Date.now()}.json`
    );
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
            MAIL_FROM: ''
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

    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_link_scope_one',
        invoiceId: 'in_link_scope_one',
        lineId: 'il_link_scope_one',
        customerId: 'cus_link_scope',
        email: 'buyer@example.com',
        created: 1700000001
    }));
    await postSignedWebhook(baseUrl, buildInvoicePaidEvent({
        eventId: 'evt_link_scope_two',
        invoiceId: 'in_link_scope_two',
        lineId: 'il_link_scope_two',
        customerId: 'cus_link_scope',
        email: 'buyer@example.com',
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

function buildInvoicePaidEvent({
    eventId,
    invoiceId,
    lineId,
    customerId,
    email,
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
                subscription: 'sub_link_scope',
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
