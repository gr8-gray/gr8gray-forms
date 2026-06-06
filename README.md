# gr8gray-forms

Cloudflare Worker that backs the teaser form on `gr8gray.dev`.

## Flow

```
gr8gray.dev /#contact  → POST JSON  → this Worker
                                       ↓
                       1. Verify Turnstile token
                       2. Validate schema (6 known fields)
                       3. Write submission to KV (audit log)
                       4. Send email to Eric via Brevo
                       5. Return { ok: true }
```

No Claude API integration in v1 — Phase A is "Eric replies within 24 hr manually." Phase C (post-Stark-Node Phase 1) adds SOW-draft generation via Jarvis dispatch.

## Setup

```bash
npm install

# Create KV namespace
npx wrangler kv namespace create FORM_LOG
# → paste returned id into wrangler.toml

# Set secrets
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put NOTIFY_TO
npx wrangler secret put NOTIFY_FROM

# Deploy
npm run deploy
```

After deploy, the Worker will live at `gr8gray-forms.<your-subdomain>.workers.dev`. Add a custom route `forms.gr8gray.dev/teaser` to it in the Cloudflare dashboard.

## Brevo setup

1. Add `gr8gray.dev` as a domain in Brevo (Senders & IP -> Domains)
2. Add the DKIM/verification/DMARC DNS records they provide to Cloudflare DNS
3. Use `forms@gr8gray.dev` (or similar) as `NOTIFY_FROM`
4. Use any address as `NOTIFY_TO`

## Turnstile setup

1. Dashboard → Turnstile → Add site → domain `gr8gray.dev`
2. Use the **site key** in the Astro form (set `PUBLIC_TURNSTILE_SITE_KEY` env var at site build)
3. Set the **secret key** via `wrangler secret put TURNSTILE_SECRET_KEY`

## Schema

```ts
{
  name_email:      string  // required, ≤200
  one_liner:       string  // required, ≤500
  success_metric:  string  // required, ≤500
  deadline:        "hard" | "soft" | "flexible"
  budget:          "lt2k" | "2to5k" | "5to10k" | "10to25k" | "gt25k" | "unsure"
  examples:        string  // required, ≤1000
  "cf-turnstile-response": string  // injected by widget
}
```
