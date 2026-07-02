# Stripe Subscription MVP

This MVP validates subscription-ticket logistics inside the OA app without
connecting Stripe to the production org backend or anonymous key-redemption path.

## Scope

- Stripe test mode creates a Premium subscription.
- `scripts/billing-demo-server.mjs` turns each `invoice.paid` webhook into one
  paid batch of 500 claimable blinded-ticket signatures and one single-use
  `/?tickets=<code>` delivery link.
- OA shows stable `Account` and `Upgrade` buttons. The Upgrade surface is a
  compact modal: `Upgrade to Premium`, `$35 / month`, `500 tickets each month`,
  a short billing/inference privacy line, and an `Upgrade` button before
  purchase. Billing now requires a verified Account for the product flow so
  Premium status and unclaimed paid batches can be recovered on another device.
- The product flow is account-scoped. The app does not ask for a billing email;
  Stripe Checkout collects it, while the billing demo server maps the Stripe
  customer/subscription to the current OA account. On allowed demo origins
  (localhost and the scoped Stripe MVP Vercel preview), the browser sends
  `X-OA-Demo-Account-ID` as a stand-in for a future production session cookie.
  Product request bodies do not carry `account_id` as proof.
- After successful Checkout, the user returns to the main OA chat page. The app
  refreshes account billing status until Premium or unclaimed tickets appear.
  It does not auto-install tickets from the Stripe redirect. When the webhook
  has created the paid entitlement, the Upgrade modal shows
  `Claim 500 Premium tickets`; that browser then generates blinded requests and
  calls `/api/billing/tickets/claim`.
- `/api/billing/tickets/claim` accepts only `blinded_requests`. The server
  derives the account from the session/header, verifies that account owns one
  unclaimed paid entitlement, signs the blinded requests, marks that entitlement
  claimed, and replays the same signatures if the saved browser claim retries.
  The server never receives finalized ticket IDs.
- The browser can redeem the emailed `/?tickets=<code>` link, claim all tickets
  represented by that code, download a ticket-shaped demo JSON, and show demo
  tickets as locally loaded through the shared billing client. The debug page
  can still manually claim currently claimable tickets for backend testing.
- The browser creates local token material, sends only blinded request hashes to
  `/api/billing/tickets/claim`, `/api/tickets/claim`, or
  `/api/ticket-links/<code>/claim`, receives fake signed blinded responses, and
  finalizes demo tickets locally.
- In demo mode, finalized fake tickets are stored under
  `oa-billing-demo-finalized-tickets`, not production `inference_tickets`.
- Demo ticket JSON is ticket-shaped for inspection, but normal ticket import
  rejects demo billing exports and `demo_` tickets so fake tickets cannot be
  loaded into production redemption storage. Finalized ticket objects are kept
  free of account, Stripe, invoice, entitlement, and billing-plan metadata.
- `/api/request_key` and production OpenRouter key issuance are not changed.

This is not a replacement for Privacy Pass. The signing flow is intentionally a
local mock that preserves the data-flow shape for product testing.

## Required Environment

Create `.env` in the repository root:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PREMIUM_PRICE_ID=price_...

APP_URL=http://localhost:8091
BILLING_SERVER_PORT=4242

# Optional. If omitted, ticket-link emails are printed in the billing server log.
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=your-email@example.com
SMTP_PASS=your-app-password
MAIL_FROM="Open Anonymity <your-email@example.com>"
```

The demo SMTP sender supports implicit TLS SMTP, typically port `465`. If these
SMTP variables are omitted, no email is sent and the same message is printed to
the billing server terminal. If SMTP is configured but delivery fails or times
out, the server also prints the same link to the terminal as a fallback. After
fixing SMTP credentials, resending the same `invoice.paid` event can retry
links whose last delivery method was `console-fallback`; successful SMTP and
console-only deliveries are still de-duplicated.

`STRIPE_STARTER_PRICE_ID` is still accepted as a legacy alias for
`STRIPE_PREMIUM_PRICE_ID`. `STRIPE_TOPUP_100_PRICE_ID` is not required for the
current product flow; top-up endpoints are debug scaffolding only. The `.env`
file is gitignored. Keep `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
backend-only.

For a short recurring-ticket demo, enable simulated monthly renewals:

```bash
BILLING_DEMO_RENEWAL_SECONDS=30
BILLING_DEMO_RENEWAL_TICKETS=500
```

When `BILLING_DEMO_RENEWAL_SECONDS` is unset or `0`, the simulator is disabled
and only real Stripe webhook events create subscription batches.

## Run Locally

Start the static app:

```bash
npm run dev
```

The branch dev server uses:

```text
http://localhost:8091
```

Start Stripe webhook forwarding in another terminal:

```bash
stripe listen --forward-to http://127.0.0.1:4242/api/stripe/webhook
```

Use the `whsec_...` value printed by the active `stripe listen` process in
`.env`.

Start or restart the demo billing server after `.env` has the current webhook
secret:

```bash
npm run billing:demo
```

To show the 30-second renewal demo, start it as:

```bash
BILLING_DEMO_RENEWAL_SECONDS=30 APP_URL=http://localhost:8091 npm run billing:demo
```

Open the OA app and click `Upgrade`:

```text
http://localhost:8091
```

For the product flow, first create or unlock Account. On localhost, and on
Vercel preview hosts matching
`oa-chat-git-stripe-subscription-mvp-*.vercel.app`, `Account` has a
`Use local test account` option so you can test cross-device subscription sync
without production passkey auth. This is a demo-only identity: anyone with the
same account ID can see that demo account's billing state.

Stripe Checkout returns to:

```text
http://localhost:8091/?billing=success
http://localhost:8091/?billing=cancelled
```

On success, the app stays on the main chat page and first shows:

```text
Payment complete. Checking Premium tickets...
```

If Stripe webhooks have created the paid entitlement, the same account shows
`Claim 500 Premium tickets` in the Upgrade modal. Clicking it downloads ticket
JSON, stores demo tickets locally, and shows them in the right panel. If the
webhook is still settling, the app shows `Payment received. Premium tickets are
still being prepared.` and account billing status will refresh again.

With `BILLING_DEMO_RENEWAL_SECONDS=30`, the browser does not wait for Stripe to
bill every 30 seconds. Instead, every account billing-status refresh asks the
demo server whether the active Premium account is due for another simulated
period. If due, the server creates one idempotent unclaimed
`subscription_demo_renewal` entitlement for the current period. The UI then
shows `Claim 500 Premium tickets`. Claiming still uses the same blinded-request
path: browser-generated blinded requests, demo server signatures, browser-local
finalization. Status responses keep total unclaimed tickets separate from the
next claimable batch, so if more than one paid/demo period is waiting the
browser claims one batch at a time. Only the verified local Account session
header path can create these demo renewal entitlements; legacy `account_id`
query status is for debug reads and does not mint renewals.

If the billing server logs `Ignoring invoice.paid without configured Premium
price`, restart it on the current code and repeat Checkout. The server now reads
both Stripe invoice line shapes: older `line.price` and current
`line.pricing.price_details.price`. If the price still does not match, the log
prints both `configured prices` and `invoice prices`; set
`STRIPE_PREMIUM_PRICE_ID` to the observed invoice price ID and restart
`npm run billing:demo`. Ignored or email-deferred `invoice.paid` events are not
recorded as fully processed. After fixing `.env`, you can resend the same Stripe
invoice event; if it was queued while waiting for Checkout email/customer data,
the restarted demo server also retries resolvable pending invoices on startup.

Premium Checkout is not repeatable for the same Account. If a still-valid
pending Premium Checkout Session exists, another `Upgrade` click returns that
same Stripe URL instead of creating a second subscription. The demo server also
serializes in-flight Premium Checkout creation per Account so two simultaneous
requests do not both create Stripe sessions. Once the current Account has
active/trialing/checkout-completed Premium, Upgrade shows unclaimed tickets
first, then `Manage billing` after the paid batch is claimed. If you previously
created sessions with `APP_URL=http://localhost:8090/billing-demo.html`, restart
the billing server with the new `APP_URL`; already-open pending Checkout
Sessions keep the return URL they were created with.

The standalone page remains available for backend debugging only:

```text
http://localhost:8091/billing-demo.html
```

The app and debug page default to `http://localhost:4242` for the billing
server. If you change `BILLING_SERVER_PORT`, set a matching browser override:

```js
localStorage.setItem('oa-billing-api-base', 'http://localhost:YOUR_PORT')
```

For local development, keep the demo billing server bound to localhost. For a
short-lived shared demo, it may be deployed as a Render web service with Stripe
test-mode keys, `BILLING_SERVER_HOST=0.0.0.0`, a persistent demo store, and the
Vercel preview frontend pointed at that backend. Do not treat that as production
auth: the demo account ID is the billing identity proof, and legacy email/debug
endpoints still use permissive CORS for browser testing.

Use Stripe's test card:

```text
4242 4242 4242 4242
```

Any future expiration date and any CVC work in test mode.

The product overlay does not ask for an email. Stripe Checkout collects the
billing email, and the demo server links that Stripe customer to the current
Account. A second browser profile can sign into the same local test account and
see Premium plus any unclaimed ticket batch. Already-claimed finalized tickets do
not move to the second profile; ticket sync is a future E2EE feature.

The frontend refreshes account billing status after Account verification, when
`Upgrade` opens, and when the tab becomes visible again. This is the client-pull
shape production should keep: the app asks whether the signed-in account has
Premium and unclaimed batches; the server does not push finalized tickets.

On localhost, the Upgrade modal includes a quiet `Demo controls` disclosure with
`Reset local demo billing`. This clears only browser-local demo billing state:
stored billing email, pending Checkout Session, pending blinded-claim batches,
and demo billing tickets. It does not cancel Stripe subscriptions, delete Stripe
customers, or mutate the demo server store. Use it when you want the popup to
return to the fresh unsubscribed state without losing the rest of the chat app.
If a same-browser ticket claim is still running, the reset invalidates that
claim before it can write local demo tickets or a stored billing email.

Once the current Account has active/trialing/checkout-completed Premium, the
product endpoint blocks another identical Premium checkout for that account. The
debug page remains email-based and can still exercise legacy manual flows.

The standalone debug page is still email-based and can create/load arbitrary
demo accounts for backend testing.

## Cross-Device Subscription Test

Use two browser profiles or a normal window plus an incognito window:

1. Profile A opens `http://localhost:8091`, opens `Account`, and uses
   `Use local test account`. Copy the displayed local account ID.
2. Profile A opens `Upgrade`, completes Stripe Checkout, then waits for
   `Claim 500 Premium tickets`.
3. Before claiming, Profile B opens `http://localhost:8091` with separate
   browser storage, enters the copied local account ID in Account, and uses
   `Use local test account`.
4. Profile B opens `Upgrade` and should see Premium plus the same unclaimed
   500-ticket batch.
5. Claim the batch in either profile. The claiming browser gets local demo
   tickets and a JSON download. The other profile still sees Premium, but the
   claimed batch is no longer available.

This intentionally tests subscription continuity, not ticket sync. Finalized
tickets remain local to the browser that claimed them until a future E2EE ticket
vault exists.

## 30-Second Renewal Demo

1. Start the billing server with:

   ```bash
   BILLING_DEMO_RENEWAL_SECONDS=30 APP_URL=http://localhost:8091 npm run billing:demo
   ```

2. Subscribe and claim the first 500-ticket batch.
3. Wait at least 30 seconds.
4. Reload the OA app, refocus the tab, or open the same Account in a second
   browser profile.
5. The browser calls `/api/billing/status`; if the account still has active
   Premium, the server creates a new unclaimed 500-ticket demo renewal batch.
6. Open `Upgrade` and claim the new `Claim 500 Premium tickets` batch.

Repeated reloads during the same 30-second period do not create duplicates. The
renewal entitlement ID is deterministic for the account, Stripe subscription,
and demo period index. If the app is closed for several demo periods, the next
status check creates only the current due batch, not a backlog.

After Stripe subscription Checkout succeeds, the `invoice.paid` webhook creates
the Premium entitlement and one delivery link:

```text
http://localhost:8091/?tickets=<code>
```

When SMTP is not configured, the billing server prints the email to its
terminal:

```text
[Billing email demo]
To: customer@example.com
Subject: Your OA Premium tickets
Tickets: 500
Link: http://localhost:8091/?tickets=<code>
```

The query-string link shape is intentional for local testing: Python's
`http.server` serves `index.html` for `/`, but it returns a static-file 404 for
direct app routes like `/tickets/<code>`.

If `APP_URL` changes from `8091` to `8090`, or the reverse, restart
`npm run billing:demo` before creating or resending a delivery. Already-created
ticket links are reprinted or resent on the next delivery attempt when the
generated link URL changes, so a link originally emitted with the wrong port is
not silently stuck.

Opening the link in OA first checks `/api/ticket-links/<code>`. When it is a
subscription link, the browser creates the local blinded request batch, persists
that batch for retry before spending entitlement, calls
`/api/ticket-links/<code>/claim`, finalizes tickets in the browser, downloads an
`exportType: "tickets"` JSON, stores demo tickets in the demo-only local store,
and clears the pending claim only after the download path and demo storage
round-trip succeed. If the link claim response is lost, retrying the same link
reuses the saved blinded requests and the server replays the same signatures.
Each link can spend only the entitlement created for that specific invoice, and
manual/debug claims ignore entitlements that already have delivery links so one
link cannot drain another link's batch. New ticket-link claim IDs include the
link code, entitlement ID, and blinded request batch without including purchaser
email, so deliberately reusing the same blinded request batch across two links
cannot collide with another link's claim or use `claim_id` as an offline email
oracle. Legacy email-based claim IDs are accepted only for replaying local links
already marked claimed before this hardening.
If the server already marked the link redeemed but the browser still has that
saved pending claim, OA retries the saved claim before showing the
already-redeemed message.
If the billing server is down, errors, or returns 404 for the code, OA falls
back to the existing invite/split ticket-code redemption path so legacy ticket
links still work. If the billing server says the subscription link was already
redeemed, OA shows a non-error already-redeemed toast.

Top-up checkout code remains in the local demo backend for future experiments,
but the OA product UI currently exposes only the single Premium subscription
option.

Webhook ordering is handled defensively for local testing: if `invoice.paid`
arrives before `checkout.session.completed` and the server cannot resolve the
customer email yet, the invoice is stored under `pendingInvoices` and processed
after Checkout completion records the Stripe customer/email mapping.

The right panel shows fake billing tickets separately from production inference
tickets, for example `Demo tickets: 500`, with an `Export JSON` action. This is
only local demo visibility; production subscription tickets should eventually
enter the normal inference ticket store after real Privacy Pass finalization.

Stripe Billing Portal sessions return to `http://localhost:8091/?billing=portal`.
The app stays on the main chat page, clears the portal URL parameter, and
refreshes stored-email billing status. If you use the browser Back button from
Stripe instead, Upgrade clears the stale `Opening portal...` state when the page
is restored.

## Privacy Boundary

The MVP keeps the intended boundary:

- Billing identity creates only paid ticket-batch entitlements.
- The emailed link is a bearer redemption code, not the finalized tickets. The
  demo issuer sees the purchaser email, the code-to-entitlement mapping, blinded
  requests, and count fulfillment.
- Finalized demo tickets are created and stored in the browser.
- Demo tickets stay out of production `inference_tickets`, so the chat app never
  tries to redeem fake tickets against the real org backend.
- Production import is gated on the ticket claim response declaring
  `ticket_mode: "production"` and returning blind-signature responses for the
  browser to finalize. Production mode must reject server-provided finalized
  ticket IDs because billing must not know finalized tickets. Until real Privacy
  Pass finalization is wired for subscription claims, the product action fails
  closed on `ticket_mode: "production"` instead of hashing fake production
  tickets into the normal ticket store. When production mode is available, the
  product action should download the ticket JSON and import it through the normal
  ticket service after real browser finalization. The local demo server declares
  `ticket_mode: "demo"`.
- Redemption, OpenRouter keys, model choices, prompts, and responses remain out
  of billing.

Production must replace the fake signing with the real Privacy Pass issuer and
must keep `/api/request_key` accountless and ticket-only.

## Claim Retries

Claim flows persist pending local token/blinded-request batches in the
`oa-billing-pending-ticket-claim` map before calling `/api/tickets/claim` or
`/api/ticket-links/<code>/claim`. Manual email claims are keyed by email;
subscription link claims are keyed as `ticket-link:<code>`. They fail closed if
browser storage cannot round-trip the pending batch, because retry material must
be durable before paid entitlement is spent. The server derives a deterministic
claim ID from the billing email and the exact blinded request batch for manual
email claims; subscription links use the link code, entitlement ID, and exact
blinded request batch instead. If the browser retries that saved batch after a
lost response or interrupted download, the server replays the same signed
blinded responses and does not increment `blindTicketsIssued` again. A different
blinded batch for an already claimed ticket link is rejected.
