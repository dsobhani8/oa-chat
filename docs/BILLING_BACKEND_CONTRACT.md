# Billing Backend Contract

This contract describes the subscription-ticket boundary that the local billing
demo server implements and the production backend should replace. It is scoped
to one Premium plan: `$35/month` for `500` tickets per paid period.

## Identity Contract

Production billing requests must be account-authenticated. The browser should
prove control of an OA account through a real account session, and the backend
must derive `account_id` from that session. A request body field is not proof of
account ownership.

Local/shared demos use this temporary stand-in:

```http
X-OA-Demo-Account-ID: 1234567890123456
```

That header is not production auth. It exists only so localhost and the scoped
Stripe MVP Vercel preview can demonstrate cross-window subscription sync before
the real account session service is connected.

Stripe Checkout still collects billing email. Email may be stored for Stripe
customer management, receipts, and optional ticket-link delivery, but email is
not the product billing identity in this contract.

## Privacy Boundary

Billing may know:

- `account_id`
- Stripe customer, subscription, invoice, and price IDs
- paid entitlement counts and whether an entitlement has been claimed
- blinded ticket requests submitted for a paid entitlement

Billing must not know:

- finalized ticket IDs or unblinded ticket tokens
- OpenRouter keys or ephemeral inference keys
- prompts, responses, model choices, provider requests, or inference logs

`/api/request_key` remains accountless and ticket-only. Finalized ticket objects
must not embed account, Stripe, invoice, entitlement, billing-plan, or email
metadata.

## Product Endpoints

### `GET /health`

Returns demo/backend readiness and Stripe configuration booleans.

### `GET /api/billing/status`

Requires authenticated account context. Demo uses `X-OA-Demo-Account-ID`.
Unauthenticated `?account_id=` status reads are not product auth. If a demo
backend keeps them for debugging, the response must be sanitized and must not
include billing email, Stripe customer IDs, raw subscription IDs, entitlement
IDs, invoice IDs, or create renewal entitlements.

Returns Premium state and claimable paid batches for the current account:

```json
{
  "accountId": "1234567890123456",
  "accountExists": true,
  "subscription": {
    "id": "sub_...",
    "status": "active",
    "currentPeriodStart": "2026-07-01T00:00:00.000Z",
    "currentPeriodEnd": "2026-08-01T00:00:00.000Z",
    "cancelAtPeriodEnd": false
  },
  "ticketsEntitled": 500,
  "blindTicketsIssued": 0,
  "claimableTickets": 500,
  "unclaimedTickets": 500,
  "nextClaimableTickets": 500,
  "entitlements": []
}
```

`claimableTickets`/`unclaimedTickets` are totals. `nextClaimableTickets` is the
one batch the browser should claim next.

### `POST /api/billing/checkout`

Requires authenticated account context. Creates or reuses a Stripe subscription
Checkout Session for the current account.

Request body may include the browser origin to use for Stripe return URLs:

```json
{ "return_origin": "https://app.openanonymity.ai" }
```

The account ID must come from auth/session context. The backend must validate
`return_origin` against an allowlist before using it in Stripe `success_url` or
`cancel_url`. If `return_origin` is missing, a browser request may fall back to
the HTTP `Origin` header after the same validation; non-browser requests can
fall back to the configured app origin. Do not accept arbitrary return origins.

Response:

```json
{ "url": "https://checkout.stripe.com/..." }
```

If a valid pending Checkout Session exists, return the same URL. If the account
already has active/trialing/checkout-completed Premium, return `409` instead of
creating another identical subscription.

### `POST /api/billing/portal`

Requires authenticated account context. Opens Stripe Billing Portal for the
current account's Stripe customer.

Request body may include the validated browser return origin:

```json
{ "return_origin": "https://app.openanonymity.ai" }
```

### `POST /api/billing/tickets/claim`

Requires authenticated account context. Accepts only blinded requests:

```json
{ "blinded_requests": ["..."] }
```

The backend picks the oldest unclaimed active entitlement owned by that account,
verifies the request count equals the entitlement's remaining ticket count, signs
the blinded requests, and marks only that entitlement spent. If the same saved
blinded request batch is retried after a lost response, the backend must replay
the same signatures without spending another entitlement.

Response:

```json
{
  "claim_id": "...",
  "signed_blinded_responses": [],
  "tickets_issued": 500,
  "ticket_mode": "demo",
  "replayed": false,
  "status": {}
}
```

The response must not include finalized tickets.

## Ticket-Link Recovery Endpoints

Ticket links remain as debug/recovery delivery, not as the primary product
checkout path.

- `GET /api/ticket-links/:code` returns public link status without purchaser
  email, account ID, Stripe customer ID, or ticket-link internals.
- `POST /api/ticket-links/:code/claim` accepts only `blinded_requests`, signs the
  batch for that link's one entitlement, and replays the same signatures for the
  same saved browser claim.

Each successful paid invoice creates at most one independent ticket link for the
specific entitlement. Redeeming one link must not redeem or mutate another link.

## Stripe Webhook Contract

`POST /api/stripe/webhook` is the payment truth. Stripe redirects are receipts
for UX only.

Required handling:

1. Verify Stripe signature.
2. Insert `stripe_event_id` idempotently.
3. Resolve the OA `account_id` from Checkout/subscription metadata or existing
   customer mapping.
4. For `checkout.session.completed`, record the account-to-Stripe-customer
   mapping and clear pending checkout state.
5. For `invoice.paid`, create exactly one Premium entitlement for that account
   and invoice line.
6. For subscription update/delete/payment failure events, update account
   subscription state without touching finalized tickets.

Duplicate or out-of-order events must not duplicate entitlements.
If an `invoice.paid` event cannot be resolved to an OA account yet, store it as
pending and retry after Checkout/subscription/customer mapping arrives. Do not
create an email-only entitlement.

## Suggested Production Tables

- `billing_accounts(account_id, stripe_customer_id, billing_email, created_at, updated_at)`
- `billing_subscriptions(account_id, stripe_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end, updated_at)`
- `stripe_events(stripe_event_id, event_type, processed_at, processing_result)`
- `ticket_entitlements(entitlement_id, account_id, stripe_invoice_id, stripe_subscription_id, stripe_price_id, ticket_count, claimed_count, status, period_start, period_end, created_at)`
- `ticket_claims(claim_id, account_id, entitlement_id, request_hash, signed_blinded_responses, tickets_issued, created_at)`
- Optional: `ticket_links(code_hash, entitlement_id, status, expires_at, claimed_at)`

Important unique constraints:

- `stripe_events.stripe_event_id`
- `billing_accounts.stripe_customer_id`
- `billing_subscriptions.stripe_subscription_id`
- `(account_id, stripe_invoice_id, stripe_price_id)` for entitlements
- `(account_id, entitlement_id, request_hash)` for claim replay
- `ticket_links.code_hash`

## Removed From Product Contract

These routes/flows are intentionally not part of the current product contract:

- `GET /api/billing/status?email=...`
- `POST /api/billing/account`
- `POST /api/billing/topup`
- `POST /api/billing/checkout-topup`
- `POST /api/billing/checkout-subscription`
- `GET /api/billing/checkout-session`
- `POST /api/billing/checkout-session/claim`
- `POST /api/tickets/claim`
