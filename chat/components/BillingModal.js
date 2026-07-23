class BillingModal {
    constructor(app) {
        this.app = app;
        this.billing = app.services.billing;
        this.account = app.services.account;
        this.overlay = document.getElementById('billing-modal');
        this.upgradeBtn = document.getElementById('upgrade-tab-btn');
        this.isOpen = false;
        this.status = null;
        this.error = null;
        this.busyAction = null;
        this.accountState = this.account?.getState?.() || {};
        this.lastAccountId = this.accountState.accountId || null;

        this.handleUpgradeClick = () => this.open();
        this.handleKeydown = (event) => {
            if (event.key === 'Escape' && this.isOpen) this.close();
        };

        this.upgradeBtn?.addEventListener('click', this.handleUpgradeClick);
        document.addEventListener('keydown', this.handleKeydown);

        if (typeof this.account?.subscribe === 'function') {
            this.accountUnsubscribe = this.account.subscribe(state => {
                this.handleAccountChange(state);
            });
        }

        this.handleBillingReturn();
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    getPlan() {
        return this.status?.plan || {
            name: 'Premium',
            priceLabel: '$35/month',
            ticketsPerPeriod: 500
        };
    }

    isAccountReady() {
        const state = this.accountState || {};
        return !!state.accountId && (state.status === 'unlocked' || state.sessionVerified === true);
    }

    handleAccountChange(state) {
        const nextAccountId = state?.accountId || null;
        const accountChanged = nextAccountId !== this.lastAccountId;
        this.accountState = state || {};
        this.lastAccountId = nextAccountId;

        if (accountChanged || !this.isAccountReady()) {
            this.status = null;
            this.error = null;
            this.billing?.resetAccountScopedState?.();
        }

        if (this.isOpen) {
            this.render();
            if (this.isAccountReady()) {
                void this.refreshAll({ silent: true });
            }
        }
    }

    handleBillingReturn() {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const billingResult = params.get('billing');
        if (!billingResult) return;

        if (billingResult === 'success') {
            this.app.showToast?.('Payment complete.', 'success', 5000);
            if (this.isAccountReady()) {
                void this.refreshAll({ silent: true });
            }
        } else if (billingResult === 'cancelled') {
            setTimeout(() => this.open(), 0);
        }

        params.delete('billing');
        params.delete('session_id');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash || ''}`;
        window.history.replaceState({}, '', nextUrl);
    }

    open() {
        if (!this.overlay) return;
        this.isOpen = true;
        this.error = null;
        this.overlay.classList.remove('hidden');
        this.upgradeBtn?.setAttribute('aria-expanded', 'true');
        this.render();
        if (this.isAccountReady()) {
            void this.refreshAll({ silent: true });
        }
    }

    close() {
        if (!this.overlay) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        this.upgradeBtn?.setAttribute('aria-expanded', 'false');
    }

    async refreshAll(options = {}) {
        if (!this.billing || !this.isAccountReady()) return null;
        if (!options.silent) {
            this.busyAction = 'status';
            this.render();
        }
        try {
            this.status = await this.billing.getStatus({ force: true });
            this.error = null;
            return this.status;
        } catch (error) {
            this.error = error.message || 'Unable to load billing status.';
            return null;
        } finally {
            if (this.busyAction === 'status') this.busyAction = null;
            if (this.isOpen) this.render();
        }
    }

    async handleCheckout() {
        if (!this.isAccountReady()) {
            this.close();
            this.app.accountModal?.open?.();
            return;
        }

        this.busyAction = 'checkout';
        this.error = null;
        this.render();
        try {
            const result = await this.billing.checkout();
            if (result?.alreadyActive) {
                this.status = result.status || this.status;
                this.busyAction = null;
                this.render();
                return;
            }
            if (!result?.url) {
                throw new Error('Billing server did not return a Checkout URL.');
            }
            window.location.href = result.url;
        } catch (error) {
            this.error = error.message || 'Unable to start Checkout.';
            this.busyAction = null;
            this.render();
        }
    }

    async handlePortal() {
        this.busyAction = 'portal';
        this.error = null;
        this.render();
        try {
            const result = await this.billing.portal();
            if (!result?.url) {
                throw new Error('Billing server did not return a portal URL.');
            }
            window.location.href = result.url;
        } catch (error) {
            this.error = error.message || 'Unable to open billing portal.';
            this.busyAction = null;
            this.render();
        }
    }

    getPendingClaim() {
        return this.billing?.getPendingTicketClaim?.() || null;
    }

    getNextClaimTicketCount() {
        const pendingClaim = this.getPendingClaim();
        if (pendingClaim?.requests?.length) return pendingClaim.requests.length;

        const claimableTickets = Math.max(0, Number(this.status?.claimableTickets) || 0);
        const entitlementCounts = Array.isArray(this.status?.entitlements)
            ? this.status.entitlements
                .map(entitlement => Math.max(0, Number(entitlement?.unclaimedTickets) || 0))
                .filter(Boolean)
            : [];
        if (entitlementCounts.length > 0) {
            return Math.max(...entitlementCounts);
        }

        const planTickets = Math.max(0, Number(this.getPlan()?.ticketsPerPeriod) || 0);
        if (claimableTickets && planTickets) return Math.min(claimableTickets, planTickets);
        return claimableTickets;
    }

    async handleClaimTickets() {
        const ticketCount = this.getNextClaimTicketCount();
        if (!ticketCount) return;

        this.busyAction = 'claim';
        this.error = null;
        this.render();
        try {
            const result = await this.billing.claimAndImportTickets(ticketCount, {
                ticketService: this.app.services.tickets
            });
            this.app.showToast?.(`${result.tickets.length} Premium tickets added.`, 'success', 6000);
            await this.refreshAll({ silent: true });
        } catch (error) {
            this.error = error.message || 'Unable to claim Premium tickets.';
        } finally {
            this.busyAction = null;
            this.render();
        }
    }

    renderAccountGate() {
        if (this.isAccountReady()) return '';
        const hasAccount = !!this.accountState?.accountId;
        return `
            <div class="billing-status billing-status-warning">
                ${hasAccount ? 'Unlock your account to manage Premium.' : 'Sign in to an account to manage Premium.'}
            </div>
        `;
    }

    renderTicketAction() {
        const pendingClaim = this.getPendingClaim();
        const ticketCount = this.getNextClaimTicketCount();
        if (!ticketCount && !pendingClaim) return '';

        const label = this.busyAction === 'claim'
            ? 'Preparing tickets...'
            : pendingClaim
                ? 'Retry ticket claim'
                : `Claim ${ticketCount} tickets`;

        return `
            <button id="billing-claim-btn" class="billing-secondary-btn" type="button" ${this.busyAction ? 'disabled' : ''}>
                ${this.escapeHtml(label)}
            </button>
        `;
    }

    renderPrimaryAction() {
        if (!this.isAccountReady()) {
            return `
                <button id="billing-account-btn" class="billing-primary-btn" type="button">
                    Open Account
                </button>
            `;
        }

        const premiumActive = this.status?.premiumActive ||
            this.status?.subscription?.active ||
            this.status?.subscription?.status === 'active';

        if (premiumActive) {
            return `
                <button id="billing-portal-btn" class="billing-primary-btn" type="button" ${this.busyAction ? 'disabled' : ''}>
                    ${this.busyAction === 'portal' ? 'Opening...' : 'Manage billing'}
                </button>
            `;
        }

        return `
            <button id="billing-checkout-btn" class="billing-primary-btn" type="button" ${this.busyAction ? 'disabled' : ''}>
                ${this.busyAction === 'checkout' ? 'Opening Stripe...' : 'Get Premium Plan'}
            </button>
        `;
    }

    render() {
        if (!this.overlay || !this.isOpen) return;
        const plan = this.getPlan();
        const statusText = this.busyAction === 'status'
            ? 'Loading billing status...'
            : this.status?.premiumActive
                ? 'Premium active'
                : this.status
                    ? 'Premium inactive'
                    : '';

        this.overlay.innerHTML = `
            <div class="billing-modal-shell fixed inset-0 flex h-screen w-screen flex-col bg-background text-foreground" role="dialog" aria-modal="true" aria-labelledby="billing-modal-title">
                <header class="billing-modal-header">
                    <button id="billing-back-btn" class="billing-icon-btn" type="button" aria-label="Back">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
                        </svg>
                    </button>
                    <span class="billing-header-status">${this.escapeHtml(statusText)}</span>
                </header>
                <main class="billing-modal-main">
                    <section class="billing-plan-panel">
                        <div class="billing-plan-copy">
                            <h1 id="billing-modal-title">${this.escapeHtml(plan.name || 'Premium')}</h1>
                            <p>${this.escapeHtml(plan.priceLabel || PREMIUM_PRICE_LABEL)} · ${Number(plan.ticketsPerPeriod) || 500} tickets per month</p>
                        </div>
                        ${this.renderAccountGate()}
                        ${this.error ? `<div class="billing-status billing-status-error">${this.escapeHtml(this.error)}</div>` : ''}
                        <div class="billing-actions">
                            ${this.renderPrimaryAction()}
                            ${this.renderTicketAction()}
                        </div>
                    </section>
                </main>
            </div>
        `;

        this.attachEvents();
    }

    attachEvents() {
        this.overlay.querySelector('#billing-back-btn')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('#billing-account-btn')?.addEventListener('click', () => {
            this.close();
            this.app.accountModal?.open?.();
        });
        this.overlay.querySelector('#billing-checkout-btn')?.addEventListener('click', () => this.handleCheckout());
        this.overlay.querySelector('#billing-portal-btn')?.addEventListener('click', () => this.handlePortal());
        this.overlay.querySelector('#billing-claim-btn')?.addEventListener('click', () => this.handleClaimTickets());
    }

    destroy() {
        this.upgradeBtn?.removeEventListener('click', this.handleUpgradeClick);
        document.removeEventListener('keydown', this.handleKeydown);
        if (this.accountUnsubscribe) {
            this.accountUnsubscribe();
            this.accountUnsubscribe = null;
        }
    }
}

const PREMIUM_PRICE_LABEL = '$35/month';

export default BillingModal;
