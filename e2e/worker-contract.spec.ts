import { test, expect } from "@playwright/test";

// Live-contract checks for the deployed worker. Every test here exits the
// worker BEFORE the KV write / Brevo email code paths, so none can generate
// a lead notification. Full happy-path E2E is deliberately deferred — an
// accepted POST emails Eric a real lead, and Turnstile can't (and shouldn't)
// be solved headlessly. See CLAUDE.md "Testing safely".

const SITE_ORIGIN = "https://gr8gray.dev";

test("OPTIONS preflight allows the site origin", async ({ request }) => {
  // The browser sends this before every form submit — if preflight breaks,
  // the funnel dies with a CORS error users never report.
  const r = await request.fetch("/teaser", {
    method: "OPTIONS",
    headers: {
      Origin: SITE_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  expect(r.status()).toBe(204);
  expect(r.headers()["access-control-allow-origin"]).toBe(SITE_ORIGIN);
  expect(r.headers()["access-control-allow-methods"]).toContain("POST");
});

test("unknown routes 404 (worker is up and routing)", async ({ request }) => {
  const r = await request.get("/definitely-not-a-route");
  expect(r.status()).toBe(404);
});

test("GET /teaser is rejected — only POST exists", async ({ request }) => {
  const r = await request.get("/teaser");
  expect(r.status()).toBe(404);
});

test("POST with a bogus Turnstile token is rejected with 403", async ({ request }) => {
  // Proves the anti-spam guard is live. The worker verifies Turnstile before
  // validation, KV, or email — a failed token means zero side effects.
  const r = await request.post("/teaser", {
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    data: {
      name_email: "E2E Probe · noreply@example.com",
      one_liner: "contract check — not a lead",
      success_metric: "n/a",
      deadline: "flexible",
      budget: "unsure",
      examples: "n/a",
      "cf-turnstile-response": "e2e-invalid-token",
    },
  });
  expect(r.status()).toBe(403);
  expect(await r.json()).toEqual({ ok: false, error: "turnstile failed" });
});

test("POST with invalid JSON returns 400", async ({ request }) => {
  // Buffer, not string: Playwright JSON-serializes string bodies under an
  // application/json content-type, which would make this valid JSON again.
  const r = await request.post("/teaser", {
    headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    data: Buffer.from("not json{{"),
  });
  expect(r.status()).toBe(400);
});
