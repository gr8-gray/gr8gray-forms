# gr8gray-forms — Architecture

Cloudflare Worker backing the teaser (lead) form on **https://gr8gray.dev**
(repo `gr8-gray/gr8gray-site`). One endpoint, one job: validate a submission,
log it, email Eric. Live at **https://forms.gr8gray.dev**.

## Tour

```
src/contract.ts    SINGLE SOURCE for the request/response contract: field names,
                   max lengths, enums, statuses, CORS allowlist. The worker half of
                   the cross-repo lockstep with gr8gray-site/src/lib/teaserContract.ts.
src/index.ts       The worker: CORS, Turnstile verify, schema validation,
                   KV audit write, Brevo email. Reads all contract values from
                   src/contract.ts — no literals. Read it top to bottom.
wrangler.toml      Worker name, custom-domain route, KV binding (FORM_LOG),
                   secret names documented in comments
.github/workflows/deploy.yml   push to main → tsc --noEmit → wrangler deploy
e2e/               Safe live-contract specs (see "Testing safely")
```

## Request contract

Only `POST /teaser` exists (plus its `OPTIONS` preflight). Everything else is 404.
Everything in this section is defined once in `src/contract.ts` (`TEASER_CONTRACT`)
and read from there by `validate()` — the tables below are documentation, the
code is the source.

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

CORS allowlist (`ORIGIN_ALLOWLIST` in `src/contract.ts`): `https://gr8gray.dev`,
`https://www.gr8gray.dev`, `http://localhost:4321`. New site origins must be added
here or the browser blocks the form — this is the classic cross-repo trap with
gr8gray-site (it cannot be single-sourced across repos; both `docs/ARCHITECTURE.md`
files flag it).

## Where submissions go

1. **KV `FORM_LOG`** — audit entry `{id, submitted_at, remoteip, user_agent, submission}`,
   1-year TTL. Written before email so nothing is lost if Brevo is down.
   Inspect: `npx wrangler kv key list --binding FORM_LOG` / `... key get <id>`.
2. **Email via Brevo** — plain-text + HTML to `NOTIFY_TO` from `NOTIFY_FROM`.

## Secrets (never in the repo)

Set with `npx wrangler secret put <NAME>`: `BREVO_API_KEY`,
`TURNSTILE_SECRET_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`. The KV namespace id in
wrangler.toml is a binding id, not a credential. See `.dev.vars.example` for
local dev.

## Deploy path

Push to `main` → `.github/workflows/deploy.yml` → `npm ci` → `npx tsc --noEmit`
→ `wrangler deploy` (CF API token from repo secrets). No staging; main is production.

## Testing safely

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

- **`forms.gr8gray.dev` is LIVE as of 2026-07-28** — the custom domain is
  attached via the `routes` block in wrangler.toml (`custom_domain = true`),
  and the E2E suite runs green against it in CI. History: the domain had no
  DNS record until 2026-07-28, so every production submission NXDOMAIN'd while
  the worker sat healthy at its `workers.dev` fallback URL.
  If the route block ever disappears from wrangler.toml, that failure mode
  comes back silently.
- "Phase A scope only": no automated SOW-draft generation yet — don't assume
  hooks for it exist.
- Brevo success is status **201**; anything else throws and downgrades the
  response to 202 (lead is safe in KV).
- Field names/enums are mirrored in gr8gray-site: `src/lib/teaserContract.ts`
  (consumed by `Contact.astro` and its e2e suite). This repo's half is
  `src/contract.ts`. The repos cannot import each other — change both in
  lockstep or production submissions start failing 400.
