# Frontend Deployment Environments

`oa-chat` keeps the production direct-request architecture: Vercel serves the
static frontend, and the browser contacts oa-org directly. Vercel does not proxy
`/auth`, `/api`, or ticket traffic.

## Build variable

Set `OA_ORG_ORIGIN` in the frontend deployment's build environment:

```text
staging:    OA_ORG_ORIGIN=https://org-staging.openanonymity.ai
production: OA_ORG_ORIGIN=https://org.openanonymity.ai
```

The build validates and embeds this public origin in the browser bundle. It is
configuration, not a secret. The value must be an HTTPS origin without a path,
query, fragment, or credentials. HTTP is accepted only for an explicit loopback
origin.

If the variable is unset, source-mode local development continues to use the
loopback org on port `8005`, while deployed hosts retain the existing production
fallback. A build produced with an explicit value uses that value even when its
`dist` directory is previewed on localhost.

Changing a Vercel environment variable does not change an existing bundle.
Redeploy after every variable change.

## Recommended deployment layout

Use separate Vercel projects for staging and production, both connected to the
same frontend repository. Build the same reviewed Git commit in both projects;
only their environment values differ.

The staging oa-org must allow the staging frontend origin for CORS, OAuth return
origins, and WebAuthn. Google OAuth callbacks and Stripe Sandbox webhooks point
to the staging oa-org, not to Vercel. oa-org returns the staging station catalog,
so the frontend does not need a station URL setting.

## Acceptance check

Before promotion:

1. Confirm `dist/build.json` records the intended `orgOrigin`.
2. In browser Network tools, confirm account, SSO, billing, ticket issuance, and
   key requests use the staging oa-org.
3. Confirm no request reaches `https://org.openanonymity.ai` from staging.
4. Complete a Stripe Sandbox purchase and ticket preparation.
5. Run one inference request through the station returned by staging oa-org.

After approval, deploy the same Git commit in the production Vercel project with
the production `OA_ORG_ORIGIN` value.
