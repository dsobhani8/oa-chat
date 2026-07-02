const DIALOG_BASE_CLASSES = 'billing-upgrade-dialog relative w-full border border-border bg-background text-foreground shadow-2xl';

class BillingModal {
    constructor(app) {
        this.app = app;
        this.billing = this.app.services.billing;
        this.account = this.app.services.account;
        this.overlay = document.getElementById('billing-modal');
        this.tabBtn = document.getElementById('billing-tab-btn');
        this.isOpen = false;
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.health = null;
        this.status = null;
        this.statusAccountId = null;
        this.accountState = this.account?.getState?.() || {};
        this.notice = null;
        this.busyAction = null;
        this.lastError = null;
        this.lastErrorScope = null;
        this.pageShowHandler = null;
        this.visibilityChangeHandler = null;
        this.checkoutSessionClaimsInFlight = new Set();
        this.closeTimer = null;
        this.renderOpeningAnimation = false;
        this.localResetGeneration = 0;

        this.accountUnsubscribe = this.account?.subscribe?.(state => {
            this.handleAccountStateChange(state);
        }) || null;

        this.attachTabListener();
        this.attachPageLifecycleListeners();
        this.updateTabIndicator();
        void this.init();
        this.handleBillingReturnParams();
    }

    attachTabListener() {
        if (!this.tabBtn) return;
        this.tabBtn.onclick = () => this.isOpen ? this.close() : this.open();
    }

    attachPageLifecycleListeners() {
        if (typeof window === 'undefined') return;
        this.pageShowHandler = () => {
            if (this.busyAction !== 'portal' && this.busyAction !== 'checkout') return;
            this.busyAction = null;
            if (this.isOpen) this.render();
            void this.refreshAll({ silent: true }).finally(() => {
                if (this.isOpen) this.render();
            });
        };
        window.addEventListener('pageshow', this.pageShowHandler);
        this.visibilityChangeHandler = () => {
            if (document.visibilityState !== 'visible' || !this.getVerifiedAccountId()) return;
            void this.refreshStatus({ silent: true }).finally(() => {
                this.updateTabIndicator();
                if (this.isOpen) this.render();
            });
        };
        document.addEventListener('visibilitychange', this.visibilityChangeHandler);
    }

    async init() {
        await this.refreshHealth({ silent: true });
        if (this.getVerifiedAccountId()) {
            await this.refreshStatus({ silent: true });
        }
        const pendingSessionId = this.billing?.getPendingCheckoutSession?.();
        if (pendingSessionId) {
            void this.handleReturnedCheckout(pendingSessionId, { fromStoredSession: true });
        }
    }

    handleAccountStateChange(state) {
        const previousAccountId = this.getVerifiedAccountId();
        this.accountState = state || {};
        const nextAccountId = this.getVerifiedAccountId();
        const verifiedAccountChanged = previousAccountId && nextAccountId && previousAccountId !== nextAccountId;
        const verifiedAccountCleared = previousAccountId && !nextAccountId;
        if (verifiedAccountChanged || verifiedAccountCleared) {
            this.localResetGeneration += 1;
            this.checkoutSessionClaimsInFlight.clear();
            this.billing?.clearPendingCheckoutSession?.();
            this.billing?.clearPendingTicketClaim?.();
            this.status = null;
            this.statusAccountId = null;
            this.busyAction = null;
            this.clearError();
            this.notice = null;
        }
        this.updateTabIndicator();
        if (this.isOpen) this.render();
        if (nextAccountId) {
            void this.refreshStatus({ silent: true });
            const pendingSessionId = this.billing?.getPendingCheckoutSession?.();
            if (pendingSessionId) {
                void this.handleReturnedCheckout(pendingSessionId, { fromStoredSession: true });
            }
        }
    }

    open(options = {}) {
        if (!this.overlay) return;
        if (this.closeTimer) {
            clearTimeout(this.closeTimer);
            this.closeTimer = null;
        }
        if (!this.isOpen) {
            this.returnFocusEl = document.activeElement;
            this.renderOpeningAnimation = true;
        }
        this.isOpen = true;
        if (options.notice) {
            this.notice = options.notice;
        }
        this.overlay.classList.remove('hidden');
        this.overlay.classList.remove('billing-modal-closing');
        this.overlay.classList.add('billing-modal-open');
        this.render();
        if (this.tabBtn) {
            this.tabBtn.setAttribute('aria-expanded', 'true');
        }

        this.overlay.onclick = (event) => {
            if (event.target === this.overlay) this.close();
        };
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
        }
        this.escapeHandler = (event) => {
            if (event.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);
        this.focusInitialControl();
        if (!options.skipRefresh) {
            void this.refreshAll();
        }
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;
        if (this.tabBtn) {
            this.tabBtn.setAttribute('aria-expanded', 'false');
        }
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        this.overlay.classList.remove('billing-modal-open');
        this.overlay.classList.add('billing-modal-closing');
        const finishClose = () => {
            if (!this.overlay || this.isOpen) return;
            this.overlay.classList.add('hidden');
            this.overlay.classList.remove('billing-modal-closing');
            this.overlay.innerHTML = '';
            if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
            this.returnFocusEl = null;
            this.closeTimer = null;
        };
        if (this.prefersReducedMotion()) {
            finishClose();
            return;
        }
        this.closeTimer = setTimeout(finishClose, 180);
    }

    async refreshAll(options = {}) {
        await this.refreshHealth(options);
        if (this.getVerifiedAccountId()) {
            await this.refreshStatus(options);
        }
    }

    async refreshHealth(options = {}) {
        if (!this.billing?.health) return;
        try {
            this.health = await this.billing.health();
            this.clearError('health');
        } catch (error) {
            this.health = { ok: false, configured: {}, error: error.message };
            this.setError(error.message || 'Billing server is not reachable.', 'health');
        }
        this.updateTabIndicator();
        if (this.isOpen && !options.silent) this.render();
    }

    async refreshStatus(options = {}) {
        if (!this.billing?.getCurrentAccountStatus) return;
        const accountId = this.getVerifiedAccountId();
        if (!accountId) {
            this.status = null;
            this.statusAccountId = null;
            this.updateTabIndicator();
            if (this.isOpen && !options.silent) this.render();
            return;
        }

        try {
            const status = await this.billing.getCurrentAccountStatus(accountId);
            if (this.getVerifiedAccountId() !== accountId) {
                return;
            }
            this.status = status;
            this.statusAccountId = accountId;
            this.clearError('status');
        } catch (error) {
            this.setError(this.formatBillingError(error, 'Unable to load billing status.'), 'status');
        }
        this.updateTabIndicator();
        if (this.isOpen && !options.silent) this.render();
    }

    handleBillingReturnParams() {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        const result = url.searchParams.get('billing');
        if (!result) return;

        if (result === 'success') {
            this.busyAction = null;
            this.notice = null;
            this.clearError();
            const sessionId = url.searchParams.get('session_id');
            if (sessionId) {
                this.billing?.setPendingCheckoutSession?.(sessionId);
                this.app?.showToast?.('Payment complete. Checking Premium tickets...', 'success', 5000);
                void this.handleReturnedCheckout(sessionId);
            } else {
                this.app?.showToast?.('Payment complete. Preparing tickets...', 'success', 7000);
            }
        } else if (result === 'cancelled') {
            this.open({ notice: 'Stripe Checkout was cancelled.' });
        } else if (result === 'portal') {
            this.app?.showToast?.('Returned from billing portal.', 'success', 4000);
            this.dispatchBillingStatusUpdated();
        }

        url.searchParams.delete('billing');
        url.searchParams.delete('session_id');
        const clean = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState({}, '', clean || '/');
    }

    async handleReturnedCheckout(sessionId, options = {}) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return;
        if (this.checkoutSessionClaimsInFlight.has(normalizedSessionId)) return;
        const accountId = this.getVerifiedAccountId();
        if (!accountId) {
            if (this.accountState?.isReady) {
                this.notice = 'Payment complete. Open Account to recover Premium status and claim tickets.';
            }
            this.updateTabIndicator();
            if (this.isOpen) this.render();
            return;
        }
        this.notice = null;

        const claimGeneration = this.localResetGeneration;
        this.checkoutSessionClaimsInFlight.add(normalizedSessionId);
        try {
            let sawPending = false;
            for (let attempt = 0; attempt < 12; attempt += 1) {
                if (this.localResetGeneration !== claimGeneration) return;
                if (attempt > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    if (this.localResetGeneration !== claimGeneration) return;
                }
                try {
                    await this.refreshStatus({ silent: true });
                    if (this.localResetGeneration !== claimGeneration) return;
                    const status = this.getCurrentStatus();
                    if (!status || this.hasCheckoutCompletedSubscription()) {
                        sawPending = true;
                        continue;
                    }
                    if (!this.hasPaidSubscription() && this.getUnclaimedTicketCount() <= 0) {
                        sawPending = true;
                        continue;
                    }
                    this.billing?.clearPendingCheckoutSession?.(normalizedSessionId);
                    const ticketCount = this.getUnclaimedTicketCount();
                    this.app?.showToast?.(
                        ticketCount > 0
                            ? `Payment complete. ${ticketCount} Premium tickets are ready to claim.`
                            : 'Payment complete. Premium is active.',
                        'success',
                        7000
                    );
                    this.dispatchBillingStatusUpdated();
                    this.updateTabIndicator();
                    if (this.isOpen) this.render();
                    return;
                } catch (error) {
                    if (error?.name === 'AbortError') return;
                    if (error?.status === 404 || error?.data?.pending) {
                        sawPending = true;
                        continue;
                    }
                    if (!options.fromStoredSession) {
                        this.app?.showToast?.(
                            error.message || 'Unable to load tickets automatically.',
                            'error',
                            8000
                        );
                    }
                    this.dispatchBillingStatusUpdated();
                    return;
                }
            }

            if (sawPending) {
                this.dispatchBillingStatusUpdated();
                if (!options.fromStoredSession) {
                    this.app?.showToast?.(
                        'Payment received. Premium tickets are still being prepared.',
                        'success',
                        7000
                    );
                }
            }
        } finally {
            this.checkoutSessionClaimsInFlight.delete(normalizedSessionId);
        }
    }

    async handleCheckout() {
        await this.startCheckout();
    }

    async startCheckout() {
        if (!this.isServerReady()) {
            this.showCheckoutError('Billing is unavailable right now.');
            return;
        }

        const accountId = this.getVerifiedAccountId();
        if (!accountId) {
            this.handleOpenAccount();
            return;
        }

        this.busyAction = 'checkout';
        this.clearError();
        this.notice = null;
        this.render();
        try {
            await this.refreshStatus({ silent: true });
            if (this.hasBlockingSubscription()) {
                this.busyAction = null;
                if (this.hasCheckoutCompletedSubscription()) {
                    this.notice = 'Payment is finishing. Tickets will appear when Stripe is ready.';
                }
                this.render();
                return;
            }
            const data = await this.billing.checkoutForCurrentAccount(accountId);
            if (data?.alreadySubscribed) {
                this.status = data.status || this.status;
                this.statusAccountId = accountId;
                this.busyAction = null;
                this.render();
                return;
            }
            window.location.href = data.url;
        } catch (error) {
            this.showCheckoutError(this.formatBillingError(error, 'Unable to start Stripe Checkout.'));
        }
    }

    showCheckoutError(message) {
        this.setError(message, 'checkout');
        this.busyAction = null;
        if (!this.isOpen) {
            this.open({ skipRefresh: true });
            this.app?.showToast?.(message, 'error', 7000);
            return;
        }
        this.render();
    }

    setError(message, scope = 'general') {
        this.lastError = message;
        this.lastErrorScope = scope;
    }

    clearError(scope = null) {
        if (scope && this.lastErrorScope !== scope) return;
        this.lastError = null;
        this.lastErrorScope = null;
    }

    async handlePortal() {
        const accountId = this.getVerifiedAccountId();
        if (!accountId) {
            this.handleOpenAccount();
            return;
        }
        this.busyAction = 'portal';
        this.clearError();
        this.notice = null;
        this.render();
        try {
            const data = await this.billing.portalForCurrentAccount(accountId);
            window.location.href = data.url;
        } catch (error) {
            this.setError(this.formatBillingError(error, 'Unable to open the billing portal.'), 'portal');
            this.busyAction = null;
            this.render();
        }
    }

    async handleClaimTickets() {
        const accountId = this.getVerifiedAccountId();
        if (!accountId) {
            this.handleOpenAccount();
            return;
        }
        const claimableTickets = this.getUnclaimedTicketCount();
        if (claimableTickets <= 0) {
            this.notice = 'No Premium tickets are ready to claim.';
            this.render();
            return;
        }

        this.busyAction = 'claim';
        this.clearError();
        this.notice = null;
        this.render();
        const resetGeneration = this.localResetGeneration;
        try {
            const result = await this.billing.redeemCurrentAccountTickets(accountId, {
                status: this.getCurrentStatus(),
                shouldAbort: () => resetGeneration !== this.localResetGeneration ||
                    this.getVerifiedAccountId() !== accountId
            });
            if (resetGeneration !== this.localResetGeneration || this.getVerifiedAccountId() !== accountId) {
                return;
            }
            await this.refreshStatus({ silent: true });
            const ticketCount = result?.tickets?.length || 0;
            this.app?.showToast?.(
                `${ticketCount || claimableTickets} demo ticket${ticketCount === 1 ? '' : 's'} loaded. Ticket JSON downloaded.`,
                'success',
                7000
            );
            this.busyAction = null;
            this.dispatchBillingStatusUpdated();
            this.uiRefreshAfterTicketLoad();
            this.render();
        } catch (error) {
            if (resetGeneration !== this.localResetGeneration || this.getVerifiedAccountId() !== accountId) {
                return;
            }
            this.setError(this.formatBillingError(error, 'Unable to claim Premium tickets.'), 'claim');
            this.busyAction = null;
            this.render();
        }
    }

    handleOpenAccount() {
        this.close();
        this.app?.accountModal?.open?.();
    }

    handleResetLocalDemoBilling() {
        if (!this.isLocalBillingDemo()) return;
        this.localResetGeneration += 1;
        this.checkoutSessionClaimsInFlight.clear();
        this.billing?.clearStoredEmail?.();
        this.billing?.clearPendingCheckoutSession?.();
        this.billing?.clearPendingTicketClaim?.();
        this.billing?.clearDemoTickets?.();
        this.status = null;
        this.statusAccountId = null;
        this.busyAction = null;
        this.clearError();
        this.notice = 'Local demo billing state reset.';
        this.updateTabIndicator();
        this.uiRefreshRightPanel();
        this.dispatchBillingStatusUpdated();
        this.render();
    }

    updateTabIndicator() {
        if (!this.tabBtn) return;
        const missingConfig = this.getMissingStripeConfig();
        const statusForAccount = this.getCurrentStatus();
        const subscription = statusForAccount?.subscription;
        const active = this.isPaidSubscription(subscription);
        const claimable = this.getUnclaimedTicketCount() > 0;
        const status = this.health && (missingConfig.length > 0 || this.health.ok === false)
            ? 'warning'
            : active
                ? claimable ? 'claimable' : 'premium'
                : 'none';
        this.tabBtn.dataset.status = status;
        this.tabBtn.title = status === 'warning'
            ? 'Premium billing unavailable'
            : 'Upgrade';
        const label = this.tabBtn.querySelector('span:last-child');
        const labelText = 'Upgrade';
        if (label) {
            label.textContent = labelText;
        }
        this.tabBtn.setAttribute('aria-label', labelText);
    }

    render() {
        if (!this.overlay) return;
        const plan = this.billing?.plan || { name: 'Premium', priceLabel: '$35/month', ticketsPerPeriod: 500 };
        const hasAccount = !!this.getVerifiedAccountId();
        const hasPremium = this.hasPaidSubscription();
        const hasPendingPremium = this.hasCheckoutCompletedSubscription();
        const unclaimedTickets = this.getUnclaimedTicketCount();
        const nextClaimableTickets = this.getNextClaimableTicketCount();
        const dialogClasses = `${DIALOG_BASE_CLASSES}${this.renderOpeningAnimation ? ' billing-upgrade-dialog-enter' : ''}`;

        this.overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-labelledby="billing-modal-title" class="${dialogClasses}" tabindex="-1">
                <button id="billing-close-btn" class="billing-upgrade-close" type="button" aria-label="Close upgrade dialog">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6 6 18"></path>
                    </svg>
                </button>
                <div class="billing-upgrade-body">
                    ${this.renderStatusArea()}
                    ${!hasAccount
                        ? this.renderAccountRequiredCard(plan)
                        : nextClaimableTickets > 0
                            ? this.renderClaimTicketsCard(plan, nextClaimableTickets, unclaimedTickets)
                            : hasPremium
                                ? this.renderSubscribedPremiumCard(plan)
                                : hasPendingPremium
                                    ? this.renderPendingPremiumCard(plan)
                                    : this.renderPremiumCard(plan)}
                    ${this.renderDemoControls()}
                </div>
            </div>
        `;
        this.renderOpeningAnimation = false;

        this.attachEventListeners();
    }

    renderStatusArea() {
        const status = this.getStatusMessage();
        const tone = status?.tone || 'neutral';
        const text = status?.text || '';
        return `
            <div class="billing-upgrade-status billing-upgrade-status-${tone}${text ? '' : ' billing-upgrade-status-empty'}" aria-live="polite" aria-atomic="true">
                ${text ? this.escapeHtml(text) : '&nbsp;'}
            </div>
        `;
    }

    getStatusMessage() {
        if (this.lastError) {
            return { tone: 'error', text: this.lastError };
        }
        if (this.notice) {
            return { tone: 'notice', text: this.notice };
        }
        if (!this.isServerReady()) {
            return {
                tone: this.health ? 'warning' : 'neutral',
                text: !this.health
                    ? 'Checking billing...'
                    : 'Billing is unavailable right now.'
            };
        }
        return null;
    }

    renderAccountRequiredCard(plan) {
        return `
            <section class="billing-upgrade-content">
                <h1 id="billing-modal-title" class="billing-upgrade-title">Upgrade to Premium</h1>
                <div class="billing-upgrade-price">${this.escapeHtml(this.formatPriceLabel(plan.priceLabel))}</div>
                <p class="billing-upgrade-entitlement">${this.escapeHtml(this.formatTicketEntitlement(plan.ticketsPerPeriod))}</p>
                <p class="billing-upgrade-privacy">Sign in with Account to keep Premium and unclaimed ticket batches available across devices.</p>
                <button id="billing-account-btn" class="billing-upgrade-primary" type="button">Open Account</button>
            </section>
        `;
    }

    renderPremiumCard(plan) {
        const serverReady = this.isServerReady();
        const canCheckout = serverReady && !this.busyAction;
        const checkoutLabel = this.busyAction === 'checkout'
            ? 'Opening Stripe...'
            : 'Upgrade';

        return `
            <section class="billing-upgrade-content">
                <h1 id="billing-modal-title" class="billing-upgrade-title">Upgrade to Premium</h1>
                <div class="billing-upgrade-price">${this.escapeHtml(this.formatPriceLabel(plan.priceLabel))}</div>
                <p class="billing-upgrade-entitlement">${this.escapeHtml(this.formatTicketEntitlement(plan.ticketsPerPeriod))}</p>
                <p class="billing-upgrade-privacy">Billing is separate from inference. Your prompts and responses are never visible to billing.</p>
                <button id="billing-checkout-btn" class="billing-upgrade-primary" type="button" ${!canCheckout ? 'disabled' : ''}>${this.escapeHtml(checkoutLabel)}</button>
                <p class="billing-upgrade-caption">Secure checkout by Stripe</p>
            </section>
        `;
    }

    renderPendingPremiumCard(plan) {
        return `
            <section class="billing-upgrade-content">
                <h1 id="billing-modal-title" class="billing-upgrade-title">Upgrade to Premium</h1>
                <div class="billing-upgrade-price">${this.escapeHtml(this.formatPriceLabel(plan.priceLabel))}</div>
                <p class="billing-upgrade-entitlement">${this.escapeHtml(this.formatTicketEntitlement(plan.ticketsPerPeriod))}</p>
                <p class="billing-upgrade-privacy">Payment is finishing. Tickets will appear when Stripe is ready.</p>
                <button class="billing-upgrade-primary" type="button" disabled>Finishing purchase...</button>
                <p class="billing-upgrade-caption">Secure checkout by Stripe</p>
            </section>
        `;
    }

    renderClaimTicketsCard(plan, ticketCount, totalTicketCount = ticketCount) {
        const canClaim = this.isServerReady() && !this.busyAction;
        const claimLabel = this.busyAction === 'claim'
            ? 'Claiming tickets...'
            : `Claim ${ticketCount} Premium tickets`;
        const availabilityText = totalTicketCount > ticketCount
            ? `${totalTicketCount} unclaimed tickets are available for this account. This browser will claim the next ${ticketCount} ticket batch.`
            : `${ticketCount} unclaimed tickets are available for this account. This browser will finalize and store them locally.`;
        return `
            <section class="billing-upgrade-content">
                <h1 id="billing-modal-title" class="billing-upgrade-title">Premium tickets ready</h1>
                <p class="billing-upgrade-active-detail">${this.escapeHtml(this.formatPriceLabel(plan.priceLabel))} · ${this.escapeHtml(this.formatTicketEntitlement(plan.ticketsPerPeriod))}</p>
                <p class="billing-upgrade-privacy">${this.escapeHtml(availabilityText)}</p>
                <button id="billing-claim-account-btn" class="billing-upgrade-primary" type="button" ${!canClaim ? 'disabled' : ''}>${this.escapeHtml(claimLabel)}</button>
            </section>
        `;
    }

    renderSubscribedPremiumCard(plan) {
        const serverReady = this.isServerReady();
        const canPortal = serverReady && !!this.getCurrentStatus()?.stripeCustomerId && !this.busyAction;
        const portalLabel = this.busyAction === 'portal' ? 'Opening portal...' : 'Manage billing';

        return `
            <section class="billing-upgrade-content">
                <h1 id="billing-modal-title" class="billing-upgrade-title">Premium active</h1>
                <p class="billing-upgrade-active-detail">${this.escapeHtml(this.formatPriceLabel(plan.priceLabel))} · ${this.escapeHtml(this.formatTicketEntitlement(plan.ticketsPerPeriod))}</p>
                <button id="billing-portal-btn" class="billing-upgrade-primary billing-upgrade-secondary-action" type="button" ${!canPortal ? 'disabled' : ''}>${this.escapeHtml(portalLabel)}</button>
            </section>
        `;
    }

    renderDemoControls() {
        if (!this.isLocalBillingDemo()) return '';
        return `
            <details class="billing-upgrade-demo-controls">
                <summary>Demo controls</summary>
                <div class="billing-upgrade-demo-body">
                    <button id="billing-reset-demo-btn" class="billing-upgrade-demo-reset" type="button">Reset local demo billing</button>
                    <p>This clears only browser demo billing state. Stripe and the demo server store are unchanged.</p>
                </div>
            </details>
        `;
    }

    attachEventListeners() {
        const closeBtn = this.overlay.querySelector('#billing-close-btn');
        if (closeBtn) closeBtn.onclick = () => this.close();

        const checkoutBtn = this.overlay.querySelector('#billing-checkout-btn');
        if (checkoutBtn) checkoutBtn.onclick = () => this.handleCheckout();

        const accountBtn = this.overlay.querySelector('#billing-account-btn');
        if (accountBtn) accountBtn.onclick = () => this.handleOpenAccount();

        const claimBtn = this.overlay.querySelector('#billing-claim-account-btn');
        if (claimBtn) claimBtn.onclick = () => this.handleClaimTickets();

        const portalBtn = this.overlay.querySelector('#billing-portal-btn');
        if (portalBtn) portalBtn.onclick = () => this.handlePortal();

        const resetDemoBtn = this.overlay.querySelector('#billing-reset-demo-btn');
        if (resetDemoBtn) resetDemoBtn.onclick = () => this.handleResetLocalDemoBilling();
    }

    focusInitialControl() {
        const target = this.overlay?.querySelector('#billing-close-btn') || this.overlay?.querySelector('[role="dialog"]');
        if (target?.focus) {
            const schedule = typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : callback => setTimeout(callback, 0);
            schedule(() => target.focus({ preventScroll: true }));
        }
    }

    prefersReducedMotion() {
        return typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    formatPriceLabel(priceLabel) {
        return String(priceLabel || '$35/month').replace(/\s*\/\s*/g, ' / ');
    }

    formatTicketEntitlement(count) {
        const value = Math.max(0, Math.floor(Number(count) || 0));
        return `${value} tickets each month`;
    }

    isLocalBillingDemo() {
        if (typeof window === 'undefined') return false;
        return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
    }

    getVerifiedAccountId() {
        const state = this.accountState || this.account?.getState?.() || {};
        if (!state?.accountId || !state?.sessionVerified) return '';
        return this.billing?.normalizeAccountId?.(state.accountId) || String(state.accountId).trim();
    }

    getCurrentStatus() {
        const accountId = this.getVerifiedAccountId();
        return accountId && this.statusAccountId === accountId ? this.status : null;
    }

    getUnclaimedTicketCount() {
        const status = this.getCurrentStatus();
        return Math.max(0, Math.floor(Number(status?.claimableTickets || status?.unclaimedTickets) || 0));
    }

    getNextClaimableTicketCount() {
        const status = this.getCurrentStatus();
        return Math.max(0, Math.floor(Number(status?.nextClaimableTickets || status?.claimableTickets || status?.unclaimedTickets) || 0));
    }

    getMissingStripeConfig() {
        return this.billing?.getMissingStripeConfig?.(this.health?.configured || {}) || [];
    }

    isServerReady() {
        return !!this.health?.ok && this.getMissingStripeConfig().length === 0;
    }

    isSubscriptionCurrent(subscription) {
        return this.isPaidSubscription(subscription) || subscription?.status === 'checkout_completed';
    }

    isPaidSubscription(subscription) {
        return ['active', 'trialing'].includes(subscription?.status);
    }

    hasBlockingSubscription() {
        return this.isSubscriptionCurrent(this.getCurrentStatus()?.subscription);
    }

    hasPaidSubscription() {
        return this.isPaidSubscription(this.getCurrentStatus()?.subscription);
    }

    hasCheckoutCompletedSubscription() {
        return this.getCurrentStatus()?.subscription?.status === 'checkout_completed';
    }

    dispatchBillingStatusUpdated() {
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
        window.dispatchEvent(new CustomEvent('billing-status-updated', {
            detail: { accountId: this.getVerifiedAccountId() }
        }));
    }

    uiRefreshAfterTicketLoad() {
        this.uiRefreshRightPanel();
        this.dispatchBillingStatusUpdated();
    }

    uiRefreshRightPanel() {
        this.app?.rightPanel?.renderTopSectionOnly?.();
    }

    formatBillingError(error, fallback) {
        const message = error?.message || fallback;
        if (error?.status === 404 || /email (is )?required/i.test(message)) {
            return 'Restart npm run billing:demo to use the current billing test mode.';
        }
        return message;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }
}

export default BillingModal;
