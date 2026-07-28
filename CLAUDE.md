# gr8gray-forms — Codebase Guide

Cloudflare Worker backing the teaser (lead) form on **https://gr8gray.dev**
(repo `gr8-gray/gr8gray-site`). One endpoint, one job: validate a submission,
log it, email Eric. Live at **https://forms.gr8gray.dev**.

## Tour

```
src/index.ts       The whole worker: CORS, Turnstile verify, schema validation,
                   KV audit write, Brevo email. ~240 lines, read it top to bottom.
wrangler.toml      Worker name, KV binding (FORM_LOG), secret names documented in comments
.github/workflows/deploy.yml   push to main → tsc --noEmit → wrangler deploy
e2e/               Safe live-contract specs (see "Testing safely")
```

## Request contract

Only `POST /teaser` exists (plus its `OPTIONS` preflight). Everything else is 404.

**Request:** JSON body with:

| field | constraint |
|---|---|
| `name_email` | string, required, ≤200 |
| `one_liner` | string, required, ≤500 |
| `success_metric` | string, required, ≤500 |
| `deadline` | `hard` \| `soft` \| `flexible` |
| `budget` | `lt2k` \| `2to5k` \| `5to10k` \| `10to25k` \| `gt25k` \| `unsure` |
| `examples` | string, required, ≤1000 |
| `cf-turnstile-response` | Turnstile token, verified server-side FIRST |

**Responses:**

| status | meaning |
|---|---|
| 204 | OPTIONS preflight |
| 200 | accepted — `{ok:true, id}`; KV logged + email sent |
| 202 | accepted — KV logged but Brevo email failed (pull the lead from KV) |
| 400 | invalid JSON or field validation errors (`{ok:false, errors:[{field,reason}]}`) |
| 403 | Turnstile verification failed |
| 404 | any other path/method |

**Order matters:** Turnstile is checked before validation, and both before any
side effect. A request with a bad token produces **no KV write and no email** —
that fact is what makes safe live testing possible (see below).

CORS allowlist (in `src/index.ts`): `https://gr8gray.dev`, `https://www.gr8gray.dev`,
`http://localhost:4321`. New site origins must be added here or the browser
blocks the form — this is the classic cross-repo trap with gr8gray-site.

## Where submissions go

1. **KV `FORM_LOG`** — audit entry `{id, submitted_at, remoteip, user_agent, submission}`,
   1-year TTL. Written before email so nothing is lost if Brevo is down.
   Inspect: `npx wrangler kv key list --binding FORM_LOG` / `... key get <id>`.
2. **Email via Brevo** — plain-text + HTML to `NOTIFY_TO` from `NOTIFY_FROM`.

## Secrets (never in the repo)

Set with `npx wrangler secret put <NAME>`: `BREVO_API_KEY`,
`TURNSTILE_SECRET_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`. The KV namespace id in
wrangler.toml is a binding id, not a credential.

## Deploy path

Push to `main` → `.github/workflows/deploy.yml` → `npm ci` → `npx tsc --noEmit`
→ `wrangler deploy` (CF API token from repo secrets). No staging; main is production.

## Testing safely (STOP 19)

**Every accepted POST emails Eric a real lead.** There is no health endpoint,
so full E2E of the happy path against production is **deliberately deferred**:
it cannot run without either generating a fake lead notification or defeating
Turnstile, and Turnstile existing to be undefeatable is the point.

What `e2e/worker-contract.spec.ts` covers instead — all side-effect-free by
construction (they exit before the KV/email code paths):

- OPTIONS preflight returns 204 with the expected CORS headers
- Unknown paths 404 (worker is up and routing)
- POST with a garbage Turnstile token → 403 (the anti-spam guard actually guards)

Run: `npx playwright test` (API-request tests, no browser download needed).
`FORMS_BASE_URL` overrides the default `https://forms.gr8gray.dev`.
CI: `.github/workflows/e2e.yml`, manual dispatch + Mondays 14:00 UTC.

Happy-path testing belongs in local dev: `npx wrangler dev` with dev secrets,
site pointed at `http://localhost:8787` via `PUBLIC_FORMS_ORIGIN`, and the
Turnstile test keypair (site `1x00000000000000000000AA` /
secret `1x0000000000000000000000000000000AA`) which always passes.

## Known traps

- **`forms.gr8gray.dev` has no DNS record as of 2026-07-27** (NXDOMAIN from
  1.1.1.1) — but the live site's form posts there, so every real submission
  currently dies with a network error. The worker IS deployed and healthy at
  `https://gr8gray-forms.ericgray928.workers.dev` (contract suite passes
  against it). Fix: attach the custom domain to the worker (dashboard →
  Worker → Settings → Domains & Routes, or add `routes` to wrangler.toml and
  redeploy). The E2E suite defaults to the custom domain on purpose — it stays
  red until the customer-facing endpoint actually works.
- "Phase A scope only" (header comment): no Claude API / SOW generation yet —
  don't assume hooks for it exist.
- Brevo success is status **201**; anything else throws and downgrades the
  response to 202 (lead is safe in KV).
- Field names/enums are duplicated in gr8gray-site's `Contact.astro`.
  Change them in lockstep or production submissions start failing 400.
