const LOCAL_BILLING_API_BASE = 'http://localhost:4242';
const STRIPE_SUBSCRIPTION_DEMO_PREVIEW_BILLING_API_BASE = 'https://oa-chat.onrender.com';
const STRIPE_SUBSCRIPTION_DEMO_PREVIEW_HOST_PATTERN = /^oa-chat-git-stripe-subscription-mvp-[a-z0-9-]+\.vercel\.app$/i;
const API_BASE_KEY = 'oa-billing-api-base';
const LEGACY_API_BASE_KEY = 'oa-billing-demo-api-base';
const EMAIL_KEY = 'oa-billing-demo-email';
const DEMO_TICKET_KEY = 'oa-billing-demo-finalized-tickets';
const PENDING_CLAIM_KEY = 'oa-billing-pending-ticket-claim';
const PENDING_CHECKOUT_SESSION_KEY = 'oa-billing-pending-checkout-session';
const PENDING_CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEMO_ACCOUNT_HEADER = 'X-OA-Demo-Account-ID';
const FORMAT_VERSION = '1.0';
const APP_NAME = 'oa-chat';

export const BILLING_PLAN = {
    id: 'premium',
    name: 'Premium',
    priceLabel: '$35/month',
    ticketsPerPeriod: 500
};

export const BILLING_TOPUP = {
    id: 'topup_100',
    name: 'Add tickets',
    ticketCount: 100,
    priceLabel: '$10',
    description: '100 tickets'
};

export function normalizeBillingEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeBillingAccountId(value) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, '') : '';
}

export function getDefaultBillingApiBaseForHostname(hostname) {
    const normalized = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
    if (STRIPE_SUBSCRIPTION_DEMO_PREVIEW_HOST_PATTERN.test(normalized)) {
        return STRIPE_SUBSCRIPTION_DEMO_PREVIEW_BILLING_API_BASE;
    }
    return LOCAL_BILLING_API_BASE;
}

export function isBillingEmailValid(value) {
    const email = normalizeBillingEmail(value);
    return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function getMissingStripeConfig(configured = {}) {
    const missing = [];
    if (!configured.stripeSecretKey) missing.push('secret key');
    if (!configured.webhookSecret) missing.push('webhook secret');
    if (!configured.premiumPriceId && !configured.starterPriceId) missing.push('price ID');
    return missing;
}

export function buildTicketExportPayload(tickets, options = {}) {
    const activeTickets = Array.isArray(tickets) ? tickets.filter(ticket => ticket?.finalized_ticket) : [];
    return {
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        app: APP_NAME,
        exportType: 'tickets',
        source: {
            type: 'stripe-subscription-mvp',
            mode: options.ticketMode || 'demo'
        },
        data: {
            tickets: {
                active: activeTickets,
                archived: []
            }
        }
    };
}

class BillingClient {
    constructor() {
        this.plan = BILLING_PLAN;
        this.topup = BILLING_TOPUP;
    }

    normalizeEmail(value) {
        return normalizeBillingEmail(value);
    }

    normalizeAccountId(value) {
        return normalizeBillingAccountId(value);
    }

    isEmailValid(value) {
        return isBillingEmailValid(value);
    }

    getMissingStripeConfig(configured = {}) {
        return getMissingStripeConfig(configured);
    }

    getApiBase() {
        if (typeof window !== 'undefined' && typeof window.OA_BILLING_API_BASE === 'string') {
            const value = window.OA_BILLING_API_BASE.trim();
            if (value) return value.replace(/\/+$/, '');
        }

        try {
            const stored = localStorage.getItem(API_BASE_KEY) || localStorage.getItem(LEGACY_API_BASE_KEY);
            if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
        } catch {
            // Local storage can be unavailable in hardened browser modes.
        }

        const hostname = typeof window !== 'undefined' ? window.location?.hostname : '';
        return getDefaultBillingApiBaseForHostname(hostname);
    }

    getStoredEmail() {
        try {
            return normalizeBillingEmail(localStorage.getItem(EMAIL_KEY) || '');
        } catch {
            return '';
        }
    }

    setStoredEmail(email) {
        const normalized = normalizeBillingEmail(email);
        if (!normalized) return '';
        try {
            localStorage.setItem(EMAIL_KEY, normalized);
        } catch {
            // Direct setters are best-effort; checkout verifies persistence separately.
        }
        return normalized;
    }

    clearStoredEmail() {
        try {
            localStorage.removeItem(EMAIL_KEY);
        } catch {
            // Non-fatal; callers also clear their in-memory billing identity.
        }
    }

    ensureDemoAccountEmail() {
        const stored = this.getStoredEmail();
        if (stored) return stored;
        const generated = this.setStoredEmail(`demo-${randomHex(8)}@example.com`);
        if (!generated || this.getStoredEmail() !== generated) {
            throw new Error('Unable to persist billing account identity. Enable browser storage before checkout.');
        }
        return generated;
    }

    async ensureDemoAccount() {
        const email = this.ensureDemoAccountEmail();
        const status = await this.getStatus(email);
        if (status?.accountExists !== false) {
            return { email, status, created: false };
        }

        const data = await this.createAccount(email);
        return {
            email,
            status: data.status || await this.getStatus(email),
            created: true
        };
    }

    async health() {
        return this.get('/health');
    }

    async getStatus(email) {
        const normalized = normalizeBillingEmail(email);
        return this.get(`/api/billing/status?email=${encodeURIComponent(normalized)}`);
    }

    async getAccountStatus(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required.');
        return this.get(`/api/billing/status?account_id=${encodeURIComponent(normalized)}`);
    }

    async getCurrentAccountStatus(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required.');
        return this.get('/api/billing/status', { accountId: normalized });
    }

    async getCheckoutSession(sessionId) {
        const normalized = normalizeTicketCode(sessionId);
        return this.get(`/api/billing/checkout-session?session_id=${encodeURIComponent(normalized)}`);
    }

    async createAccount(email) {
        return this.post('/api/billing/account', { email: normalizeBillingEmail(email) });
    }

    async checkout(email) {
        const normalized = normalizeBillingEmail(email);
        return this.post('/api/billing/checkout', normalized ? { email: normalized } : {});
    }

    async checkoutForCurrentAccount(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required before checkout.');
        return this.post('/api/billing/checkout', {}, { accountId: normalized });
    }

    async checkoutTopup(email) {
        const normalized = normalizeBillingEmail(email);
        if (!normalized) throw new Error('Premium is required before adding tickets.');
        return this.post('/api/billing/topup', { email: normalized });
    }

    async checkoutSubscriptionForAccount(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required before checkout.');
        return this.post('/api/billing/checkout-subscription', { account_id: normalized });
    }

    async checkoutTopupForAccount(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required before checkout.');
        return this.post('/api/billing/checkout-topup', { account_id: normalized });
    }

    async portal(email) {
        return this.post('/api/billing/portal', { email: normalizeBillingEmail(email) });
    }

    async portalForCurrentAccount(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required.');
        return this.post('/api/billing/portal', {}, { accountId: normalized });
    }

    async portalForAccount(accountId) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required.');
        return this.post('/api/billing/portal', { account_id: normalized });
    }

    async claim(email, blindedRequests) {
        return this.post('/api/tickets/claim', {
            email: normalizeBillingEmail(email),
            blinded_requests: Array.isArray(blindedRequests) ? blindedRequests : []
        });
    }

    async claimCurrentAccountTickets(accountId, blindedRequests) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required before claiming tickets.');
        return this.post('/api/billing/tickets/claim', {
            blinded_requests: Array.isArray(blindedRequests) ? blindedRequests : []
        }, { accountId: normalized });
    }

    async getTicketLink(code) {
        const normalized = normalizeTicketCode(code);
        if (!normalized) throw new Error('A ticket link code is required.');
        return this.get(`/api/ticket-links/${encodeURIComponent(normalized)}`);
    }

    async claimTicketLink(code, blindedRequests) {
        const normalized = normalizeTicketCode(code);
        if (!normalized) throw new Error('A ticket link code is required.');
        return this.post(`/api/ticket-links/${encodeURIComponent(normalized)}/claim`, {
            blinded_requests: Array.isArray(blindedRequests) ? blindedRequests : []
        });
    }

    async claimCheckoutSession(sessionId, blindedRequests) {
        const normalized = normalizeSessionId(sessionId);
        if (!normalized) throw new Error('A Checkout Session ID is required.');
        return this.post('/api/billing/checkout-session/claim', {
            session_id: normalized,
            blinded_requests: Array.isArray(blindedRequests) ? blindedRequests : []
        });
    }

    async get(path, options = {}) {
        const response = await fetch(`${this.getApiBase()}${path}`, {
            headers: this.buildHeaders(options)
        });
        return this.parseResponse(response);
    }

    async post(path, body, options = {}) {
        const response = await fetch(`${this.getApiBase()}${path}`, {
            method: 'POST',
            headers: this.buildHeaders(options, { 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
        });
        return this.parseResponse(response);
    }

    buildHeaders(options = {}, baseHeaders = {}) {
        const headers = { ...baseHeaders };
        const accountId = normalizeBillingAccountId(options.accountId);
        if (accountId) {
            headers[DEMO_ACCOUNT_HEADER] = accountId;
        }
        return headers;
    }

    async parseResponse(response) {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || `Billing request failed (${response.status})`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    async generateBlindedTicketRequests(count) {
        const ticketCount = Math.max(0, Math.floor(Number(count) || 0));
        const requests = [];
        for (let index = 0; index < ticketCount; index += 1) {
            const token = randomHex(32);
            requests.push({
                token,
                blindedRequest: await sha256(`demo-blinded:${token}`)
            });
        }
        return requests;
    }

    getPendingTicketClaim(email) {
        const normalized = normalizeBillingEmail(email);
        if (!normalized) return null;

        try {
            const claims = readPendingClaimMap();
            const claim = claims[normalized] || null;
            if (!claim) return null;
            const createdAt = Date.parse(claim.createdAt || '');
            if (Number.isFinite(createdAt) && Date.now() - createdAt > PENDING_CLAIM_MAX_AGE_MS) {
                delete claims[normalized];
                try {
                    writePendingClaimMap(claims);
                } catch {
                    // Expiry cleanup is best-effort on read.
                }
                return null;
            }
            const requests = normalizePendingRequests(claim.requests);
            if (requests.length === 0) return null;
            return {
                email: normalized,
                count: requests.length,
                requests,
                createdAt: claim.createdAt || new Date().toISOString()
            };
        } catch {
            return null;
        }
    }

    savePendingTicketClaim(claim) {
        const email = normalizeBillingEmail(claim?.email);
        const requests = normalizePendingRequests(claim?.requests);
        if (!email || requests.length === 0) return null;

        const pending = {
            email,
            count: requests.length,
            requests,
            createdAt: claim.createdAt || new Date().toISOString()
        };
        try {
            const claims = readPendingClaimMap();
            claims[email] = pending;
            writePendingClaimMap(claims);
            const confirmed = this.getPendingTicketClaim(email);
            if (!arePendingClaimsEqual(pending, confirmed)) {
                throw new Error('Pending claim round-trip verification failed.');
            }
        } catch (error) {
            throw new Error('Unable to save pending ticket claim for retry. Enable browser storage before claiming tickets.');
        }
        return pending;
    }

    async getOrCreatePendingTicketClaim(email, count) {
        const existing = this.getPendingTicketClaim(email);
        if (existing) return existing;

        const requests = await this.generateBlindedTicketRequests(count);
        return this.savePendingTicketClaim({
            email,
            requests,
            createdAt: new Date().toISOString()
        });
    }

    getPendingTicketLinkClaim(code) {
        return this.getPendingTicketClaim(getTicketLinkPendingKey(code));
    }

    getPendingCheckoutSessionClaim(sessionId) {
        return this.getPendingTicketClaim(getCheckoutSessionPendingKey(sessionId));
    }

    async getOrCreatePendingTicketLinkClaim(code, count) {
        return this.getOrCreatePendingTicketClaim(getTicketLinkPendingKey(code), count);
    }

    async getOrCreatePendingCheckoutSessionClaim(sessionId, count) {
        return this.getOrCreatePendingTicketClaim(getCheckoutSessionPendingKey(sessionId), count);
    }

    getPendingAccountTicketClaim(accountId) {
        return this.getPendingTicketClaim(getAccountPendingKey(accountId));
    }

    async getOrCreatePendingAccountTicketClaim(accountId, count) {
        return this.getOrCreatePendingTicketClaim(getAccountPendingKey(accountId), count);
    }

    clearPendingTicketLinkClaim(code) {
        this.clearPendingTicketClaim(getTicketLinkPendingKey(code));
    }

    clearPendingCheckoutSessionClaim(sessionId) {
        this.clearPendingTicketClaim(getCheckoutSessionPendingKey(sessionId));
    }

    clearPendingAccountTicketClaim(accountId) {
        this.clearPendingTicketClaim(getAccountPendingKey(accountId));
    }

    clearPendingTicketClaim(email) {
        const normalized = normalizeBillingEmail(email);
        try {
            const claims = readPendingClaimMap();
            if (!normalized) {
                localStorage.removeItem(PENDING_CLAIM_KEY);
                return;
            }
            delete claims[normalized];
            writePendingClaimMap(claims);
        } catch {
            try {
                if (!normalized) {
                    localStorage.removeItem(PENDING_CLAIM_KEY);
                }
            } catch {
                // Nothing else to do.
            }
        }
    }

    async buildTicketPayloadFromClaim({ requests, claimResponse, status } = {}) {
        const ticketMode = claimResponse?.ticket_mode === 'production' ? 'production' : 'demo';
        const tickets = await this.finalizeTicketsFromClaim({
            requests: Array.isArray(requests) ? requests : [],
            claimResponse,
            status,
            ticketMode
        });

        return {
            ticketMode,
            tickets,
            payload: buildTicketExportPayload(tickets, { ticketMode })
        };
    }

    async finalizeTicketsFromClaim({ requests, claimResponse, status, ticketMode }) {
        const directTickets = Array.isArray(claimResponse?.finalized_tickets)
            ? claimResponse.finalized_tickets
            : null;

        if (ticketMode === 'production' && directTickets?.length > 0) {
            throw new Error('Production ticket claims must be finalized in the browser from blind-signature responses.');
        }

        if (ticketMode !== 'production' && directTickets) {
            return directTickets
                .map(ticket => normalizeTicketForExport(ticket, ticketMode))
                .filter(ticket => ticket?.finalized_ticket);
        }

        const signedResponses = Array.isArray(claimResponse?.signed_blinded_responses)
            ? claimResponse.signed_blinded_responses
            : [];
        if (ticketMode === 'production' && signedResponses.some(signed => signed?.finalized_ticket)) {
            throw new Error('Production ticket claims must not include server-provided finalized ticket IDs.');
        }
        if (ticketMode === 'production') {
            throw new Error('Production subscription tickets require real Privacy Pass finalization before import.');
        }

        const allocationByResponseIndex = expandAllocations(claimResponse?.allocations || []);
        const fallbackAllocation = status?.entitlements?.find(entitlement => entitlement?.claimableTickets > 0) || {};

        const tickets = [];
        for (const signed of signedResponses) {
            const responseIndex = Number.isFinite(signed?.index) ? signed.index : tickets.length;
            const request = requests[responseIndex];
            if (!request) continue;

            const signedValue = ticketMode === 'production'
                ? signed.signed_blinded_response || signed.signature || ''
                : signed.finalized_ticket || signed.signed_blinded_response || signed.signature || '';
            if (!signedValue) continue;

            const finalizedTicket = signed.finalized_ticket || await sha256(`demo-final:${request.token}:${signedValue}`);
            tickets.push(cleanObject({
                finalized_ticket: ticketMode === 'demo' && !String(finalizedTicket).startsWith('demo_')
                    ? `demo_${finalizedTicket}`
                    : finalizedTicket,
                issued_at: new Date().toISOString()
            }));
        }

        return tickets;
    }

    async redeemCurrentAccountTickets(accountId, options = {}) {
        const normalized = normalizeBillingAccountId(accountId);
        if (!normalized) throw new Error('Account is required before claiming tickets.');
        const status = options.status || await this.getCurrentAccountStatus(normalized);
        const pendingClaim = this.getPendingAccountTicketClaim(normalized);
        const ticketCount = Math.max(0, Math.floor(Number(status?.nextClaimableTickets || status?.claimableTickets || status?.unclaimedTickets) || 0));
        const requestCount = pendingClaim?.requests?.length || ticketCount;
        if (requestCount <= 0) {
            throw new Error('No Premium tickets are ready to claim.');
        }

        const claim = pendingClaim || await this.getOrCreatePendingAccountTicketClaim(normalized, requestCount);
        const claimResponse = await this.claimCurrentAccountTickets(
            normalized,
            claim.requests.map(request => request.blindedRequest)
        );
        const { ticketMode, tickets, payload } = await this.buildTicketPayloadFromClaim({
            requests: claim.requests,
            claimResponse,
            status: claimResponse.status || status || null
        });
        if (typeof options.shouldAbort === 'function' && options.shouldAbort()) {
            throw new Error('Ticket claim was cancelled.');
        }

        if (tickets.length === 0) {
            throw new Error('No tickets were returned for this account.');
        }
        if (this.isProductionTicketPayload(ticketMode)) {
            throw new Error('Production subscription tickets are not enabled yet.');
        }
        if (typeof options.shouldAbort === 'function' && options.shouldAbort()) {
            throw new Error('Ticket claim was cancelled.');
        }
        if (!this.downloadTicketPayload(payload)) {
            throw new Error('Unable to start the ticket download in this browser.');
        }

        if (typeof options.shouldAbort === 'function' && options.shouldAbort()) {
            throw new Error('Ticket claim was cancelled.');
        }
        this.addDemoTickets(tickets);
        this.clearPendingAccountTicketClaim(normalized);
        return {
            accountId: normalized,
            status: claimResponse.status || status || null,
            ticketMode,
            tickets,
            payload
        };
    }

    isProductionTicketPayload(ticketMode) {
        return ticketMode === 'production';
    }

    async redeemTicketLink(code) {
        const normalized = normalizeTicketCode(code);
        const link = await this.getTicketLink(normalized);
        const pendingClaim = this.getPendingTicketLinkClaim(normalized);
        const ticketCount = Math.max(0, Math.floor(Number(link?.ticket_count || link?.ticketCount) || 0));
        const requestCount = pendingClaim?.requests?.length || ticketCount;
        if (requestCount <= 0) {
            throw new Error('This ticket link does not have tickets to load.');
        }

        const claim = pendingClaim || await this.getOrCreatePendingTicketLinkClaim(normalized, requestCount);
        const claimResponse = await this.claimTicketLink(
            normalized,
            claim.requests.map(request => request.blindedRequest)
        );
        const { ticketMode, tickets, payload } = await this.buildTicketPayloadFromClaim({
            requests: claim.requests,
            claimResponse,
            status: claimResponse.status || null
        });

        if (tickets.length === 0) {
            throw new Error('No tickets were returned for this link.');
        }
        if (this.isProductionTicketPayload(ticketMode)) {
            throw new Error('Production subscription tickets are not enabled yet.');
        }
        if (!this.downloadTicketPayload(payload)) {
            throw new Error('Unable to start the ticket download in this browser.');
        }

        this.addDemoTickets(tickets);
        this.clearPendingTicketLinkClaim(normalized);
        return {
            code: normalized,
            link,
            ticketMode,
            tickets,
            payload
        };
    }

    async redeemCheckoutSession(sessionId, options = {}) {
        const normalized = normalizeSessionId(sessionId);
        assertCheckoutClaimActive(options);
        const session = await this.getCheckoutSession(normalized);
        assertCheckoutClaimActive(options);

        const pendingClaim = this.getPendingCheckoutSessionClaim(normalized);
        const ticketCount = Math.max(0, Math.floor(Number(session?.ticketCount || session?.ticket_count) || 0));
        const fallbackCount = session?.checkoutType === 'topup'
            ? BILLING_TOPUP.ticketCount
            : BILLING_PLAN.ticketsPerPeriod;
        const requestCount = pendingClaim?.requests?.length || ticketCount || fallbackCount;
        if (requestCount <= 0) {
            return { pending: true, session };
        }

        const claim = pendingClaim || await this.getOrCreatePendingCheckoutSessionClaim(normalized, requestCount);
        assertCheckoutClaimActive(options);
        const claimResponse = await this.claimCheckoutSession(
            normalized,
            claim.requests.map(request => request.blindedRequest)
        );
        assertCheckoutClaimActive(options);
        if (claimResponse?.pending) {
            const pendingSession = claimResponse.session || session;
            const email = normalizeBillingEmail(pendingSession?.email || pendingSession?.billingEmail || '');
            if (email) this.setStoredEmail(email);
            return { pending: true, session: pendingSession, claim };
        }

        const claimSession = claimResponse?.session || session;
        const email = normalizeBillingEmail(claimSession?.email || claimSession?.billingEmail || '');
        if (email) this.setStoredEmail(email);

        const { ticketMode, tickets, payload } = await this.buildTicketPayloadFromClaim({
            requests: claim.requests,
            claimResponse,
            status: claimResponse.status || null
        });

        assertCheckoutClaimActive(options);
        if (tickets.length === 0) {
            throw new Error('No tickets were returned for this Checkout Session.');
        }
        if (this.isProductionTicketPayload(ticketMode)) {
            throw new Error('Production subscription tickets are not enabled yet.');
        }
        if (!this.downloadTicketPayload(payload)) {
            throw new Error('Unable to start the ticket download in this browser.');
        }

        this.addDemoTickets(tickets);
        this.clearPendingCheckoutSessionClaim(normalized);
        this.clearPendingCheckoutSession();
        return {
            sessionId: normalized,
            session: claimSession,
            ticketMode,
            tickets,
            payload
        };
    }

    getPendingCheckoutSession() {
        try {
            return normalizeSessionId(localStorage.getItem(PENDING_CHECKOUT_SESSION_KEY) || '');
        } catch {
            return '';
        }
    }

    setPendingCheckoutSession(sessionId) {
        const normalized = normalizeSessionId(sessionId);
        if (!normalized) return '';
        try {
            localStorage.setItem(PENDING_CHECKOUT_SESSION_KEY, normalized);
        } catch {
            // Best-effort recovery helper; the active return flow still proceeds.
        }
        return normalized;
    }

    clearPendingCheckoutSession(sessionId = null) {
        try {
            const normalized = normalizeSessionId(sessionId);
            if (normalized && this.getPendingCheckoutSession() !== normalized) return;
            localStorage.removeItem(PENDING_CHECKOUT_SESSION_KEY);
        } catch {
            // Non-fatal.
        }
    }

    getDemoTickets() {
        try {
            const parsed = JSON.parse(localStorage.getItem(DEMO_TICKET_KEY) || '[]');
            if (!Array.isArray(parsed)) return [];
            const now = Date.now();
            const active = parsed.filter(ticket => {
                if (!ticket?.finalized_ticket) return false;
                if (!ticket.expires_at) return true;
                const expiresAt = Date.parse(ticket.expires_at);
                return Number.isFinite(expiresAt) && expiresAt > now;
            });
            if (active.length !== parsed.length) {
                localStorage.setItem(DEMO_TICKET_KEY, JSON.stringify(active));
            }
            return active;
        } catch {
            return [];
        }
    }

    addDemoTickets(tickets) {
        const existing = this.getDemoTickets();
        const seen = new Set(existing.map(ticket => ticket.finalized_ticket));
        const merged = [...existing];

        (Array.isArray(tickets) ? tickets : []).forEach(ticket => {
            if (!ticket?.finalized_ticket || seen.has(ticket.finalized_ticket)) return;
            seen.add(ticket.finalized_ticket);
            merged.push(ticket);
        });

        try {
            localStorage.setItem(DEMO_TICKET_KEY, JSON.stringify(merged));
        } catch {
            throw new Error('Unable to store demo tickets locally. Enable browser storage before loading tickets.');
        }
        const confirmed = this.getDemoTickets();
        const confirmedIds = new Set(confirmed.map(ticket => ticket.finalized_ticket));
        if (!merged.every(ticket => confirmedIds.has(ticket.finalized_ticket))) {
            throw new Error('Unable to store demo tickets locally. Enable browser storage before loading tickets.');
        }
        this.notifyDemoTicketsUpdated();
        return merged.length;
    }

    getDemoTicketCount() {
        return this.getDemoTickets().length;
    }

    clearDemoTickets() {
        try {
            localStorage.removeItem(DEMO_TICKET_KEY);
        } catch {
            // Non-fatal; the reset control also clears in-memory billing state.
        }
        this.notifyDemoTicketsUpdated();
    }

    downloadDemoTicketPayload() {
        const tickets = this.getDemoTickets();
        if (tickets.length === 0) return false;
        return this.downloadTicketPayload(buildTicketExportPayload(tickets, { ticketMode: 'demo' }));
    }

    notifyDemoTicketsUpdated() {
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
        window.dispatchEvent(new CustomEvent('billing-demo-tickets-updated', {
            detail: { count: this.getDemoTicketCount() }
        }));
    }

    downloadTicketPayload(payload) {
        if (typeof document === 'undefined' ||
            typeof Blob === 'undefined' ||
            typeof URL === 'undefined' ||
            typeof URL.createObjectURL !== 'function') {
            return false;
        }

        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `oa-chat-subscription-tickets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        if (typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(url);
        }
        return true;
    }
}

function normalizePendingRequests(requests) {
    return (Array.isArray(requests) ? requests : [])
        .map(request => ({
            token: typeof request?.token === 'string' ? request.token : '',
            blindedRequest: typeof request?.blindedRequest === 'string' ? request.blindedRequest : ''
        }))
        .filter(request => request.token && request.blindedRequest);
}

function normalizeTicketCode(value) {
    return typeof value === 'string' ? value.trim().replace(/[\s-]+/g, '') : '';
}

function normalizeSessionId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function assertCheckoutClaimActive(options = {}) {
    if (typeof options?.shouldContinue !== 'function' || options.shouldContinue()) return;
    const error = new Error('Checkout Session claim was reset.');
    error.name = 'AbortError';
    throw error;
}

function getTicketLinkPendingKey(code) {
    const normalized = normalizeTicketCode(code);
    return normalized ? `ticket-link:${normalized.toLowerCase()}` : '';
}

function getCheckoutSessionPendingKey(sessionId) {
    const normalized = normalizeSessionId(sessionId);
    return normalized ? `checkout-session:${normalized.toLowerCase()}` : '';
}

function getAccountPendingKey(accountId) {
    const normalized = normalizeBillingAccountId(accountId);
    return normalized ? `account:${normalized.toLowerCase()}` : '';
}

function readPendingClaimMap() {
    const parsed = JSON.parse(localStorage.getItem(PENDING_CLAIM_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return {};

    const rawClaims = parsed.claims && typeof parsed.claims === 'object'
        ? parsed.claims
        : parsed.email
            ? { [normalizeBillingEmail(parsed.email)]: parsed }
            : {};

    return Object.fromEntries(
        Object.entries(rawClaims)
            .map(([key, claim]) => {
                const email = normalizeBillingEmail(claim?.email || key);
                const requests = normalizePendingRequests(claim?.requests);
                if (!email || requests.length === 0) return null;
                return [email, {
                    email,
                    count: requests.length,
                    requests,
                    createdAt: claim.createdAt || new Date().toISOString()
                }];
            })
            .filter(Boolean)
    );
}

function writePendingClaimMap(claims) {
    const entries = Object.entries(claims || {})
        .filter(([, claim]) => normalizePendingRequests(claim?.requests).length > 0);
    if (entries.length === 0) {
        localStorage.removeItem(PENDING_CLAIM_KEY);
        return;
    }

    localStorage.setItem(PENDING_CLAIM_KEY, JSON.stringify({
        formatVersion: FORMAT_VERSION,
        claims: Object.fromEntries(entries)
    }));
}

function arePendingClaimsEqual(expected, actual) {
    if (!expected || !actual) return false;
    if (normalizeBillingEmail(expected.email) !== normalizeBillingEmail(actual.email)) return false;
    const expectedRequests = normalizePendingRequests(expected.requests);
    const actualRequests = normalizePendingRequests(actual.requests);
    if (expectedRequests.length !== actualRequests.length) return false;
    return expectedRequests.every((request, index) =>
        request.token === actualRequests[index]?.token &&
        request.blindedRequest === actualRequests[index]?.blindedRequest
    );
}

function normalizeTicketForExport(ticket, ticketMode) {
    if (!ticket) return null;
    if (typeof ticket === 'string') {
        return {
            finalized_ticket: ticket,
            issued_at: new Date().toISOString()
        };
    }
    return cleanObject({
        finalized_ticket: ticket.finalized_ticket,
        issued_at: ticket.issued_at || new Date().toISOString()
    });
}

function expandAllocations(allocations) {
    const expanded = [];
    allocations.forEach(allocation => {
        const count = Number.isFinite(allocation?.ticketsIssued)
            ? allocation.ticketsIssued
            : 0;
        for (let index = 0; index < count; index += 1) {
            expanded.push(allocation);
        }
    });
    return expanded;
}

function cleanObject(value) {
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')
    );
}

function randomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('Web Crypto is unavailable in this browser.');
    }
    const data = new TextEncoder().encode(value);
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const billingClient = new BillingClient();

if (typeof window !== 'undefined') {
    window.billingClient = billingClient;
}

export default billingClient;
