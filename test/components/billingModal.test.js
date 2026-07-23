import test from 'node:test';
import assert from 'node:assert/strict';

import BillingModal from '../../chat/components/BillingModal.js';

function createModal({ status, pendingClaim = null } = {}) {
    const modal = Object.create(BillingModal.prototype);
    modal.status = status || null;
    modal.billing = {
        getPendingTicketClaim: () => pendingClaim
    };
    return modal;
}

test('billing modal claims one entitlement batch when multiple periods are unclaimed', () => {
    const modal = createModal({
        status: {
            claimableTickets: 1000,
            plan: { ticketsPerPeriod: 500 },
            entitlements: [
                { unclaimedTickets: 500 },
                { unclaimedTickets: 500 }
            ]
        }
    });

    assert.equal(modal.getNextClaimTicketCount(), 500);
});

test('billing modal falls back to plan-sized claim batches without entitlement rows', () => {
    const modal = createModal({
        status: {
            claimableTickets: 1000,
            plan: { ticketsPerPeriod: 500 }
        }
    });

    assert.equal(modal.getNextClaimTicketCount(), 500);
});

test('billing modal prioritizes saved pending claim count when status has no claimable tickets', () => {
    const modal = createModal({
        status: {
            claimableTickets: 0,
            plan: { ticketsPerPeriod: 500 },
            entitlements: []
        },
        pendingClaim: {
            requests: Array.from({ length: 500 }, (_, index) => ({ index }))
        }
    });

    assert.equal(modal.getNextClaimTicketCount(), 500);
});
