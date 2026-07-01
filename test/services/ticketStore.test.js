import test from 'node:test';
import assert from 'node:assert/strict';

import ticketStore from '../../chat/services/ticketStore.js';

test('ticket import rejects demo billing export wrappers', () => {
    assert.throws(
        () => ticketStore.extractImportTickets({
            exportType: 'tickets',
            source: {
                type: 'stripe-subscription-mvp',
                mode: 'demo'
            },
            data: {
                tickets: {
                    active: [{ finalized_ticket: 'demo_ticket_one', source: 'stripe-billing-demo' }],
                    archived: []
                }
            }
        }),
        /Demo billing ticket files/
    );
});

test('ticket import rejects unwrapped demo billing tickets', () => {
    assert.throws(
        () => ticketStore.extractImportTickets({
            active: [{ finalized_ticket: 'demo_ticket_two', source: 'stripe-billing-demo' }],
            archived: []
        }),
        /Demo billing ticket files/
    );
});

test('ticket import accepts production subscription ticket exports', () => {
    const result = ticketStore.extractImportTickets({
        exportType: 'tickets',
        source: {
            type: 'stripe-subscription-mvp',
            mode: 'production'
        },
        data: {
            tickets: {
                active: [{ finalized_ticket: 'prod_ticket_one', source: 'stripe-subscription' }],
                archived: []
            }
        }
    });

    assert.equal(result.activeTickets.length, 1);
    assert.equal(result.activeTickets[0].finalized_ticket, 'prod_ticket_one');
});

test('ticket normalization drops existing demo billing tickets', () => {
    const result = ticketStore.normalizeTickets([
        { finalized_ticket: 'demo_ticket_old', source: 'stripe-billing-demo' },
        { finalized_ticket: 'prod_ticket_two', source: 'stripe-subscription' }
    ]);

    assert.equal(result.changed, true);
    assert.deepEqual(result.tickets.map(ticket => ticket.finalized_ticket), ['prod_ticket_two']);
});
