# OA Billing Demo Vercel Deployment

> **TEST ONLY — DO NOT MERGE THIS BRANCH INTO A PRODUCT BRANCH.**

This branch records the source and routing overlay used by the test billing
demo at:

```text
https://oa-billing-demo.vercel.app
```

It is based on the clean client handoff branch and adds only deployment
configuration:

- `ORG_API_BASE` and `SHARE_BASE_URL` use the stable Vercel production origin.
- Vercel proxies only `/auth/*`, `/api/*`, and `/chat/*` to the current
  Cloudflare Quick Tunnel before applying the SPA fallback.
- A temporary verifier exception is enabled only when both the page and org
  API use the exact HTTPS production hostname above.
- Vercel preview URLs, HTTP, lookalike hosts, and unrelated domains remain
  fail-closed.

The current backend transport is:

```text
https://labour-divine-sides-parts.trycloudflare.com
```

That Quick Tunnel hostname is volatile. If it changes, update only the three
external destinations in `vercel.json`, deploy a newly verified static
artifact, and rerun the routing and webhook transport checks. The public
Vercel URL, WebAuthn RP ID, share URL, and Stripe webhook URL must remain
unchanged.

The temporary verifier exception must be removed when collaborator-owned
verifier configuration becomes available. It is not a product authentication
mode.

Build locally and deploy only the checked `dist` directory plus `vercel.json`.
Do not link Vercel to a dirty worktree. This repository must never contain
Stripe, OpenRouter, SSH, database, Cloudflare tunnel, recovery-code, or Vercel
credentials.

Validate before deployment:

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
```

The matching org product source is commit
`6625480b5766414aa85c845dc6e89cdefd3344eb` on
`OpenAnonymity-FPL/oa-org:feature/billing-ticket-topups`.
