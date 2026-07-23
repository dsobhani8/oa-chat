# Account-Linked Billing

Account-linked billing uses the OA account only to authorize Stripe subscription
state and blind ticket entitlement claims. It does not attach account identity to
ticket redemption or inference.

## Account And Stripe State

- Browser identity comes from `accountService`; billing calls require an unlocked
  or server-verified account.
- `GET /api/billing/status` returns the authenticated account's Premium state,
  Stripe customer availability, portal availability, and unclaimed entitlement
  counts.
- `POST /api/billing/checkout` creates or reuses one Stripe customer for the
  authenticated account and starts hosted Stripe Checkout.
- `POST /api/billing/portal` opens Stripe Billing Portal for that account's
  Stripe customer.
- Active Premium blocks duplicate checkout and the UI shows `Manage billing`.

The local shim lives at `scripts/billing-demo-server.mjs` and defaults to
`http://localhost:4242`. Run it with:

```bash
npm run billing-server
```

The shim is for local account/Stripe/entitlement contract testing. It accepts
bearer/cookie account auth, can derive a stable demo account from bearer tokens,
and has an opt-in localhost-only `X-OA-Demo-Account-ID` fallback for manual
testing. It also returns credential-compatible CORS headers for loopback app
origins so `http://localhost:8080` can call `http://localhost:4242` with account
cookies. Production billing should rely on the normal account session verifier,
not on an account ID request body or billing-specific identity field.

## Entitlement Lifecycle

Stripe webhooks are processed by account/customer/invoice-line identity:

- `checkout.session.completed` records the account/customer mapping.
- `invoice.paid` creates one 500-ticket Premium entitlement for each matching
  paid invoice line.
- Stripe event IDs and invoice-line IDs are recorded so webhook retries do not
  create duplicate entitlements.
- Entitlements store counts and claim status only. They never store finalized
  ticket IDs.

If an invoice arrives before the account/customer mapping is known, the demo
server keeps it under `pendingInvoices` and processes it after the mapping is
available.

For local claim tests, the shim persists a demo Privacy Pass issuer key in its
store, exposes it through `/api/ticket/issue/public-key`, and signs blinded
requests with the bundled issuer. Production must sign with the production
issuer key accepted by `/api/request_key`; the local shim key is only for
end-to-end claim/finalization testing.

## Blind Claim Flow

`POST /api/billing/tickets/claim` accepts:

```json
{ "blinded_requests": [[0, "..." ], [1, "..."]] }
```

The account is authenticated by the account session, not by request body fields.
The server verifies that the authenticated account owns enough unclaimed
entitlement, marks the entitlement spent, and returns:

```json
{
  "ticket_mode": "production",
  "signed_responses": [[0, "..."], [1, "..."]],
  "tickets_issued": 500
}
```

The browser saves pending blinded-request state and serialized Privacy Pass
finalization state before submitting the claim. It then finalizes signed
responses locally with Privacy Pass and imports only normal ticket fields
(`blinded_request`, `signed_response`, `finalized_ticket`, `created_at`) through
the existing ticket store. Server-provided finalized ticket IDs are rejected.

Replaying the same saved blinded batch returns the same signed responses and does
not spend a second entitlement. Switching accounts clears cached billing UI state
and hides pending claims for the prior account. If more than one paid period has
unclaimed tickets, the browser claims one entitlement-sized batch at a time
rather than summing every period into one claim.

## Privacy Boundary

Billing endpoints may see account identity, Stripe customer/subscription IDs,
and blinded ticket requests. They must not see finalized tickets, ephemeral API
keys, model choices, prompts, responses, chat session IDs, or provider payloads.

Unchanged accountless paths:

- `/api/request_key`
- provider/OpenRouter requests
- model selection
- prompt/response handling
- inference network logging

Finalized ticket imports reject account, Stripe, entitlement, and billing
metadata so billing state cannot be carried into redemption or inference.
