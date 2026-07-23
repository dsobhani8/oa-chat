import { ORG_API_BASE } from '../config.js';
import accountService from './accountService.js';
import privacyPassProvider from './privacyPass.js';
import ticketStore from './ticketStore.js';

const DEFAULT_LOCAL_BILLING_BASE = 'http://localhost:4242';
const PENDING_CLAIMS_KEY = 'oa-billing-pending-ticket-claim-v2';
const DEFAULT_PREMIUM_TICKET_COUNT = 500;

function getDefaultBillingBase() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.OA_BILLING_API_BASE === 'string' && globalThis.OA_BILLING_API_BASE.trim()) {
        return globalThis.OA_BILLING_API_BASE.trim().replace(/\/+$/, '');
    }

    if (typeof window !== 'undefined') {
        const host = window.location?.hostname;
        if (host === 'localhost' || host === '127.0.0.1') {
            return DEFAULT_LOCAL_BILLING_BASE;
        }
    }

    return ORG_API_BASE.replace(/\/+$/, '');
}

function getStorage(storageOverride) {
    if (storageOverride) return storageOverride;
    if (typeof localStorage !== 'undefined') return localStorage;
    return null;
}

function createBillingError(message, options = {}) {
    const error = new Error(message);
    if (options.code) error.code = options.code;
    if (Number.isFinite(options.status)) error.status = options.status;
    if (options.data) error.data = options.data;
    return error;
}

function parseJsonText(text) {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

function normalizeAccountId(accountId) {
    return typeof accountId === 'string' ? accountId.trim() : '';
}

function getRandomHex(bytes = 16) {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.getRandomValues) {
        const data = new Uint8Array(bytes);
        cryptoObj.getRandomValues(data);
        return Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, bytes * 2);
}

function normalizePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPlainJsonValue(value) {
    if (value === null) return true;
    if (['string', 'number', 'boolean'].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.every(isPlainJsonValue);
    if (typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every(isPlainJsonValue);
}

function isLoopbackHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function normalizeBlindedRequestPairs(blindedRequests) {
    if (!Array.isArray(blindedRequests)) return [];
    return blindedRequests.map((entry, index) => {
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

function normalizeSignedResponses(claimResponse = {}) {
    const source = claimResponse.signed_responses ||
        claimResponse.signed_blinded_responses ||
        claimResponse.signedResponses ||
        claimResponse.signedBlindedResponses ||
        [];

    if (!Array.isArray(source)) return [];

    return source.map((entry, index) => {
        if (Array.isArray(entry)) {
            return {
                index: Number.isFinite(Number(entry[0])) ? Number(entry[0]) : index,
                signedResponse: String(entry[1] || '')
            };
        }
        if (entry && typeof entry === 'object') {
            return {
                index: Number.isFinite(Number(entry.index)) ? Number(entry.index) : index,
                signedResponse: String(entry.signed_response || entry.signed_blinded_response || entry.signedResponse || '')
            };
        }
        return { index, signedResponse: String(entry || '') };
    }).filter(entry => entry.signedResponse);
}

function getClaimTicketsIssued(claimResponse = {}) {
    const value = claimResponse.tickets_issued ?? claimResponse.ticketsIssued;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function assertNoServerFinalizedTickets(claimResponse = {}) {
    if (Array.isArray(claimResponse.finalized_tickets) ||
        Array.isArray(claimResponse.finalizedTickets) ||
        claimResponse.finalized_ticket ||
        claimResponse.finalizedTicket) {
        throw createBillingError('Production billing tickets must be finalized in the browser.', {
            code: 'BILLING_SERVER_FINALIZED_TICKETS'
        });
    }

    const signed = claimResponse.signed_responses ||
        claimResponse.signed_blinded_responses ||
        claimResponse.signedResponses ||
        claimResponse.signedBlindedResponses ||
        [];

    for (const entry of Array.isArray(signed) ? signed : []) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            if (entry.finalized_ticket || entry.finalizedTicket || entry.ticket_id || entry.ticketId) {
                throw createBillingError('Signed billing responses must not include server-provided finalized ticket IDs.', {
                    code: 'BILLING_SERVER_FINALIZED_TICKET_ID'
                });
            }
        }
    }
}

function serializePendingClaim(claim) {
    return {
        accountId: claim.accountId,
        createdAt: claim.createdAt,
        ticketCount: claim.ticketCount,
        requests: (claim.requests || []).map(request => ({
            index: request.index,
            blindedRequest: request.blindedRequest,
            stateKey: request.stateKey,
            serializedState: request.serializedState
        }))
    };
}

export function buildTicketExportPayload(tickets, options = {}) {
    const activeTickets = Array.isArray(tickets)
        ? tickets.filter(ticket => ticket?.finalized_ticket).map(ticket => ({ ...ticket }))
        : [];

    return {
        exportType: 'tickets',
        version: 1,
        exportedAt: new Date().toISOString(),
        source: {
            type: 'stripe-subscription',
            mode: options.ticketMode || 'production'
        },
        data: {
            tickets: {
                active: activeTickets,
                archived: []
            }
        }
    };
}

export function getMissingStripeConfig(config = {}) {
    const missing = [];
    if (!config.stripeSecretKey) missing.push('Stripe secret key');
    if (!config.webhookSecret) missing.push('webhook secret');
    if (!config.premiumPriceId && !config.starterPriceId) missing.push('price ID');
    return missing;
}

export class BillingClient {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || getDefaultBillingBase()).replace(/\/+$/, '');
        this.accountService = options.accountService || accountService;
        this.privacyPass = options.privacyPass || privacyPassProvider;
        this.ticketStore = options.ticketStore || ticketStore;
        this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
        this.storage = getStorage(options.storage);
        this.defaultTicketCount = normalizePositiveInteger(options.defaultTicketCount, DEFAULT_PREMIUM_TICKET_COUNT);
        this.statusCache = null;
        this.statusAccountId = null;
        this.currentAccountId = normalizeAccountId(this.accountService?.getState?.().accountId);
        this.pendingStateCache = new Map();

        if (options.subscribeToAccount !== false && typeof this.accountService?.subscribe === 'function') {
            this.unsubscribeAccount = this.accountService.subscribe(state => {
                this.handleAccountStateChange(state);
            });
        }
    }

    destroy() {
        if (this.unsubscribeAccount) {
            this.unsubscribeAccount();
            this.unsubscribeAccount = null;
        }
    }

    getAccountState() {
        return this.accountService?.getState?.() || {};
    }

    getAccessToken() {
        return typeof this.accountService?.getAccessToken === 'function'
            ? this.accountService.getAccessToken()
            : null;
    }

    isAccountUsable(state = this.getAccountState()) {
        const accountId = normalizeAccountId(state.accountId);
        if (!accountId) return false;
        if (state.status === 'unlocked') return true;
        return state.sessionVerified === true;
    }

    async requireAccountAuth() {
        let state = this.getAccountState();
        let accountId = normalizeAccountId(state.accountId);

        if (!accountId) {
            throw createBillingError('Sign in to an account before managing Premium.', {
                code: 'BILLING_ACCOUNT_REQUIRED'
            });
        }

        if (!this.isAccountUsable(state) && typeof this.accountService?.refreshAccessToken === 'function') {
            await this.accountService.refreshAccessToken();
            state = this.getAccountState();
            accountId = normalizeAccountId(state.accountId);
        }

        if (!this.isAccountUsable(state)) {
            throw createBillingError('Unlock your account before managing Premium.', {
                code: 'BILLING_ACCOUNT_LOCKED'
            });
        }

        const accessToken = this.getAccessToken();
        if (!accessToken && state.sessionVerified !== true) {
            throw createBillingError('Account session is unavailable. Sign in again before managing Premium.', {
                code: 'BILLING_ACCOUNT_AUTH_UNAVAILABLE'
            });
        }

        return { accountId, accessToken, state };
    }

    buildUrl(path) {
        return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    }

    shouldSendLocalDemoAccountHeader() {
        try {
            const url = new URL(this.baseUrl);
            return isLoopbackHostname(url.hostname) && globalThis.OA_BILLING_DEMO_ACCOUNT_HEADER === true;
        } catch {
            return false;
        }
    }

    async request(path, options = {}) {
        const auth = await this.requireAccountAuth();
        const headers = {
            Accept: 'application/json',
            ...(options.headers || {})
        };

        if (auth.accessToken) {
            headers.Authorization = `Bearer ${auth.accessToken}`;
        }

        if (auth.accountId && this.shouldSendLocalDemoAccountHeader()) {
            headers['X-OA-Demo-Account-ID'] = auth.accountId;
        }

        let body = options.body;
        if (body && typeof body !== 'string') {
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
            body = JSON.stringify(body);
        }

        const response = await this.fetchImpl(this.buildUrl(path), {
            method: options.method || (body ? 'POST' : 'GET'),
            headers,
            body,
            credentials: 'include',
            signal: options.signal
        });

        const text = typeof response.text === 'function'
            ? await response.text()
            : JSON.stringify(await response.json?.() || {});
        const data = parseJsonText(text);

        if (!response.ok) {
            throw createBillingError(data.error || data.message || `Billing request failed (${response.status})`, {
                code: data.code || 'BILLING_REQUEST_FAILED',
                status: response.status,
                data
            });
        }

        return data;
    }

    async getStatus(options = {}) {
        const auth = await this.requireAccountAuth();
        if (!options.force && this.statusCache && this.statusAccountId === auth.accountId) {
            return this.statusCache;
        }
        const status = await this.request('/api/billing/status', { method: 'GET', signal: options.signal });
        this.statusCache = status;
        this.statusAccountId = auth.accountId;
        return status;
    }

    getCurrentStatus() {
        return this.statusCache;
    }

    async checkout(options = {}) {
        const status = options.skipStatus ? null : await this.getStatus({ force: true, signal: options.signal }).catch(() => null);
        if (status?.premiumActive || status?.subscription?.active || status?.subscription?.status === 'active') {
            return {
                alreadyActive: true,
                premiumActive: true,
                portalAvailable: status.portalAvailable !== false,
                status
            };
        }
        return this.request('/api/billing/checkout', {
            method: 'POST',
            body: {},
            signal: options.signal
        });
    }

    async portal(options = {}) {
        return this.request('/api/billing/portal', {
            method: 'POST',
            body: {},
            signal: options.signal
        });
    }

    async fetchPublicKey(options = {}) {
        const response = await this.fetchImpl(this.buildUrl('/api/ticket/issue/public-key'), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            credentials: 'omit',
            signal: options.signal
        });
        const text = typeof response.text === 'function'
            ? await response.text()
            : JSON.stringify(await response.json?.() || {});
        const data = parseJsonText(text);
        if (!response.ok || !data.public_key) {
            throw createBillingError(data.error || data.message || 'Unable to load ticket issuer public key.', {
                code: 'BILLING_PUBLIC_KEY_UNAVAILABLE',
                status: response.status,
                data
            });
        }
        return data.public_key;
    }

    async createBlindedTicketRequests(count = this.defaultTicketCount, options = {}) {
        const ticketCount = normalizePositiveInteger(count, this.defaultTicketCount);
        const publicKey = options.publicKey || await this.fetchPublicKey(options);
        const requests = [];

        for (let index = 0; index < ticketCount; index += 1) {
            const result = await this.privacyPass.createSingleTokenRequest(publicKey);
            const stateKey = `state_${Date.now().toString(36)}_${index}_${getRandomHex(8)}`;
            const serializedState = result.serializedState ||
                this.serializeLocalStateForStorage(result.state, publicKey);
            const request = {
                index,
                blindedRequest: result.blindedRequest,
                state: result.state,
                stateKey,
                serializedState
            };
            this.pendingStateCache.set(stateKey, result.state);
            requests.push(request);
        }

        return requests;
    }

    readPendingClaimMap() {
        if (!this.storage) return {};
        const raw = this.storage.getItem(PENDING_CLAIMS_KEY);
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    writePendingClaimMap(map) {
        if (!this.storage) {
            throw createBillingError('Unable to save pending ticket claim.', {
                code: 'BILLING_PENDING_STORAGE_UNAVAILABLE'
            });
        }

        const serialized = JSON.stringify(map);
        try {
            this.storage.setItem(PENDING_CLAIMS_KEY, serialized);
            const roundTrip = this.storage.getItem(PENDING_CLAIMS_KEY);
            if (roundTrip !== serialized) {
                throw new Error('Storage round trip failed');
            }
        } catch (error) {
            throw createBillingError('Unable to save pending ticket claim.', {
                code: 'BILLING_PENDING_STORAGE_UNAVAILABLE',
                data: { cause: error.message }
            });
        }
    }

    hydratePendingClaim(claim) {
        if (!claim) return null;
        return {
            ...claim,
            requests: (claim.requests || []).map(request => ({
                ...request,
                state: request.state ||
                    this.pendingStateCache.get(request.stateKey) ||
                    (request.serializedState?.type === 'raw-json' ? request.serializedState.value : null)
            }))
        };
    }

    serializeLocalStateForStorage(state, publicKey = null) {
        if (!state) return null;
        if (typeof this.privacyPass?.serializeState === 'function') {
            try {
                return this.privacyPass.serializeState(state, publicKey);
            } catch {
                // Fall through to the JSON stub path used by unit tests.
            }
        }
        if (isPlainJsonValue(state)) {
            return { type: 'raw-json', value: JSON.parse(JSON.stringify(state)) };
        }
        return null;
    }

    savePendingTicketClaim(claim, accountId = null) {
        const accountKey = normalizeAccountId(accountId) || normalizeAccountId(claim.accountId) || normalizeAccountId(this.getAccountState().accountId);
        if (!accountKey) {
            throw createBillingError('Cannot save a billing ticket claim without an account.', {
                code: 'BILLING_ACCOUNT_REQUIRED'
            });
        }

        const pending = {
            accountId: accountKey,
            createdAt: claim.createdAt || new Date().toISOString(),
            ticketCount: normalizePositiveInteger(claim.ticketCount, (claim.requests || []).length || this.defaultTicketCount),
            requests: (Array.isArray(claim.requests) ? claim.requests : []).map(request => {
                const serializedState = request.serializedState ||
                    this.serializeLocalStateForStorage(request.state, request.publicKey || claim.publicKey);
                if (!serializedState) {
                    throw createBillingError('Unable to save recoverable Privacy Pass state for this billing claim.', {
                        code: 'BILLING_LOCAL_STATE_NOT_SERIALIZABLE'
                    });
                }
                return {
                    ...request,
                    serializedState
                };
            })
        };

        pending.requests.forEach(request => {
            if (request?.state && request?.stateKey) {
                this.pendingStateCache.set(request.stateKey, request.state);
            }
        });

        const map = this.readPendingClaimMap();
        map[accountKey] = serializePendingClaim(pending);
        this.writePendingClaimMap(map);

        const saved = this.readPendingClaimMap()[accountKey];
        if (!saved ||
            saved.requests?.length !== pending.requests.length ||
            saved.requests.some(request => !request.serializedState)) {
            throw createBillingError('Unable to save pending ticket claim.', {
                code: 'BILLING_PENDING_STORAGE_UNAVAILABLE'
            });
        }

        return this.hydratePendingClaim(saved);
    }

    getPendingTicketClaim(accountId = null) {
        const accountKey = normalizeAccountId(accountId) || normalizeAccountId(this.getAccountState().accountId);
        if (!accountKey) return null;
        return this.hydratePendingClaim(this.readPendingClaimMap()[accountKey] || null);
    }

    clearPendingTicketClaim(accountId = null) {
        const accountKey = normalizeAccountId(accountId) || normalizeAccountId(this.getAccountState().accountId);
        if (!accountKey || !this.storage) return;
        const map = this.readPendingClaimMap();
        const claim = map[accountKey];
        if (claim?.requests) {
            claim.requests.forEach(request => {
                if (request?.stateKey) this.pendingStateCache.delete(request.stateKey);
            });
        }
        delete map[accountKey];
        this.writePendingClaimMap(map);
    }

    async getOrCreatePendingTicketClaim(count = this.defaultTicketCount, options = {}) {
        const auth = await this.requireAccountAuth();
        const existing = this.getPendingTicketClaim(auth.accountId);
        if (existing?.requests?.length) return existing;

        const requests = await this.createBlindedTicketRequests(count, options);
        return this.savePendingTicketClaim({
            accountId: auth.accountId,
            ticketCount: requests.length,
            requests
        }, auth.accountId);
    }

    async claim(blindedRequests, options = {}) {
        const pairs = normalizeBlindedRequestPairs(blindedRequests);
        if (pairs.length === 0) {
            throw createBillingError('No blinded ticket requests to claim.', {
                code: 'BILLING_EMPTY_CLAIM'
            });
        }

        return this.request('/api/billing/tickets/claim', {
            method: 'POST',
            body: { blinded_requests: pairs },
            signal: options.signal
        });
    }

    async buildTicketPayloadFromClaim({ requests, claimResponse }) {
        return buildTicketPayloadFromClaim({
            requests,
            claimResponse,
            privacyPass: this.privacyPass
        });
    }

    async claimPremiumTickets(count = this.defaultTicketCount, options = {}) {
        const auth = await this.requireAccountAuth();
        const pending = await this.getOrCreatePendingTicketClaim(count, options);
        const blindedRequests = pending.requests.map(request => [request.index, request.blindedRequest]);
        const claimResponse = await this.claim(blindedRequests, options);
        const result = await this.buildTicketPayloadFromClaim({
            requests: pending.requests,
            claimResponse
        });
        result.accountId = auth.accountId;
        return result;
    }

    async claimAndImportTickets(count = this.defaultTicketCount, options = {}) {
        const result = await this.claimPremiumTickets(count, options);
        const importer = options.ticketService || this.ticketStore;

        if (typeof importer?.importTickets === 'function') {
            await importer.importTickets(result.payload);
        } else if (typeof importer?.addTickets === 'function') {
            await importer.addTickets(result.tickets);
        } else {
            throw createBillingError('Ticket storage is unavailable.', {
                code: 'BILLING_TICKET_IMPORT_UNAVAILABLE'
            });
        }

        this.clearPendingTicketClaim(result.accountId);
        this.statusCache = null;
        return result;
    }

    handleAccountStateChange(state = this.getAccountState()) {
        const nextAccountId = normalizeAccountId(state.accountId);
        const accountChanged = nextAccountId !== this.currentAccountId;
        this.currentAccountId = nextAccountId;

        if (accountChanged || !this.isAccountUsable(state)) {
            this.statusCache = null;
            this.statusAccountId = null;
        }
    }

    resetAccountScopedState() {
        this.statusCache = null;
        this.statusAccountId = null;
    }
}

export async function buildTicketPayloadFromClaim({ requests, claimResponse, privacyPass = privacyPassProvider }) {
    assertNoServerFinalizedTickets(claimResponse);

    const ticketMode = claimResponse?.ticket_mode || claimResponse?.ticketMode || 'production';
    if (ticketMode !== 'production') {
        throw createBillingError('Unsupported billing ticket mode.', {
            code: 'BILLING_UNSUPPORTED_TICKET_MODE'
        });
    }

    const signedResponses = normalizeSignedResponses(claimResponse);
    if (signedResponses.length === 0) {
        throw createBillingError('Billing server did not return signed ticket responses.', {
            code: 'BILLING_SIGNED_RESPONSES_MISSING'
        });
    }

    const localRequests = Array.isArray(requests) ? requests : [];
    const expectedCount = localRequests.length;
    const ticketsIssued = getClaimTicketsIssued(claimResponse);
    if (expectedCount > 0 && signedResponses.length !== expectedCount) {
        throw createBillingError('Billing server returned an incomplete signed ticket batch.', {
            code: 'BILLING_SIGNED_RESPONSE_COUNT_MISMATCH'
        });
    }
    if (ticketsIssued !== null && ticketsIssued !== signedResponses.length) {
        throw createBillingError('Billing server ticket count did not match signed responses.', {
            code: 'BILLING_TICKETS_ISSUED_MISMATCH'
        });
    }
    if (ticketsIssued !== null && expectedCount > 0 && ticketsIssued !== expectedCount) {
        throw createBillingError('Billing server ticket count did not match the pending claim.', {
            code: 'BILLING_TICKETS_ISSUED_MISMATCH'
        });
    }

    const seenSignedIndexes = new Set();
    for (const signed of signedResponses) {
        if (seenSignedIndexes.has(signed.index)) {
            throw createBillingError('Billing server returned duplicate signed ticket indexes.', {
                code: 'BILLING_DUPLICATE_SIGNED_RESPONSE'
            });
        }
        seenSignedIndexes.add(signed.index);
    }

    const requestMap = new Map(localRequests.map((request, fallbackIndex) => [
        Number.isFinite(Number(request.index)) ? Number(request.index) : fallbackIndex,
        request
    ]));

    const tickets = [];
    for (const signed of signedResponses) {
        const request = requestMap.get(signed.index);
        if (!request?.blindedRequest) {
            throw createBillingError(`Missing local blinded request for ticket ${signed.index}.`, {
                code: 'BILLING_LOCAL_REQUEST_MISSING'
            });
        }
        let localState = request.state || null;
        if (!localState && request.serializedState) {
            if (request.serializedState.type === 'raw-json') {
                localState = request.serializedState.value;
            } else {
                localState = request.serializedState;
            }
        }
        if (!localState) {
            throw createBillingError('Production subscription tickets need saved local Privacy Pass state for real Privacy Pass finalization.', {
                code: 'BILLING_LOCAL_FINALIZATION_STATE_MISSING'
            });
        }

        let finalizedTicket;
        try {
            finalizedTicket = await privacyPass.finalizeToken(signed.signedResponse, localState);
        } catch (error) {
            throw createBillingError(`Unable to finish real Privacy Pass finalization: ${error.message}`, {
                code: 'BILLING_LOCAL_FINALIZATION_FAILED'
            });
        }

        tickets.push({
            blinded_request: request.blindedRequest,
            signed_response: signed.signedResponse,
            finalized_ticket: finalizedTicket,
            created_at: new Date().toISOString()
        });
    }

    return {
        ticketMode,
        tickets,
        payload: buildTicketExportPayload(tickets, { ticketMode })
    };
}

const billingClient = new BillingClient();

if (typeof window !== 'undefined') {
    window.billingClient = billingClient;
}

export default billingClient;
