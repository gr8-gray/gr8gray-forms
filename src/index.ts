/**
 * gr8gray-forms — Cloudflare Worker
 *
 * Receives teaser-form submissions from gr8gray.dev, validates them
 * (Turnstile + schema), writes an audit log to KV, and emails Eric via Brevo.
 *
 * Phase A scope only — no Claude API integration, no SOW generation.
 *
 * The request/response contract (field names, max lengths, enums, statuses)
 * is single-sourced in src/contract.ts — the cross-repo lockstep half of
 * gr8gray-site's src/lib/teaserContract.ts. Read its header before editing.
 */

import {
  BudgetValue,
  CANONICAL_SITE_ORIGIN,
  DeadlineValue,
  ORIGIN_ALLOWLIST,
  TEASER_CONTRACT,
} from "./contract";

export interface Env {
  FORM_LOG: KVNamespace;
  BREVO_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  NOTIFY_TO: string;
  NOTIFY_FROM: string;
}

const STATUS = TEASER_CONTRACT.status;

type FieldError = { field: string; reason: string };

type TeaserSubmission = {
  name_email: string;
  one_liner: string;
  success_metric: string;
  deadline: DeadlineValue;
  budget: BudgetValue;
  examples: string;
};

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(ORIGIN_ALLOWLIST);

function corsHeaders(origin: string | null): Record<string, string> {
  // Unknown/missing Origin still gets a valid header (the canonical site) so
  // the response is never CORS-malformed; the browser enforces the mismatch.
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : CANONICAL_SITE_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function validate(payload: Record<string, unknown>): {
  ok: true;
  data: TeaserSubmission;
} | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];

  function strField(name: string, max: number): string {
    const v = payload[name];
    if (typeof v !== "string" || v.trim().length === 0) {
      errors.push({ field: name, reason: "required" });
      return "";
    }
    if (v.length > max) {
      errors.push({ field: name, reason: `max length ${max}` });
      return v.slice(0, max);
    }
    return v.trim();
  }

  function enumField<T extends readonly string[]>(name: string, allowed: T): T[number] {
    const v = payload[name];
    if (typeof v !== "string" || !allowed.includes(v as T[number])) {
      errors.push({ field: name, reason: `must be one of ${allowed.join("|")}` });
      return allowed[0];
    }
    return v as T[number];
  }

  const data: TeaserSubmission = {
    name_email: strField("name_email", TEASER_CONTRACT.fieldMax.name_email),
    one_liner: strField("one_liner", TEASER_CONTRACT.fieldMax.one_liner),
    success_metric: strField("success_metric", TEASER_CONTRACT.fieldMax.success_metric),
    deadline: enumField("deadline", TEASER_CONTRACT.enums.deadline),
    budget: enumField("budget", TEASER_CONTRACT.enums.budget),
    examples: strField("examples", TEASER_CONTRACT.fieldMax.examples),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data };
}

async function verifyTurnstile(
  token: string,
  secret: string,
  remoteip: string | null,
): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteip) body.set("remoteip", remoteip);
  const r = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  if (!r.ok) return false;
  const result = (await r.json()) as { success?: boolean };
  return result.success === true;
}

async function sendEmail(
  env: Env,
  submission: TeaserSubmission,
  meta: { id: string; remoteip: string | null; userAgent: string | null },
): Promise<void> {
  const lines = [
    `New gr8gray.dev teaser submission`,
    `ID: ${meta.id}`,
    `IP: ${meta.remoteip ?? "n/a"}`,
    `UA: ${meta.userAgent ?? "n/a"}`,
    ``,
    `Name + email: ${submission.name_email}`,
    `One-liner: ${submission.one_liner}`,
    `Success metric (90d): ${submission.success_metric}`,
    `Timeline: ${submission.deadline}`,
    `Budget: ${submission.budget}`,
    `Examples: ${submission.examples}`,
  ];
  const text = lines.join("\n");

  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: env.NOTIFY_FROM, name: "gr8gray.dev" },
      to: [{ email: env.NOTIFY_TO }],
      subject: `[gr8gray.dev] ${submission.one_liner.slice(0, 60)}`,
      htmlContent: `<pre>${text.replace(/[&<>]/g, (c) =>
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
      )}</pre>`,
      textContent: text,
    }),
  });

  if (r.status !== 201) {
    const body = await r.text();
    throw new Error(`Brevo ${r.status}: ${body}`);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: STATUS.preflight, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== TEASER_CONTRACT.path || request.method !== "POST") {
      return new Response("not found", { status: STATUS.notFound, headers: cors });
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { ok: false, error: "invalid json" },
        { status: STATUS.badRequest, headers: cors },
      );
    }

    const token =
      (payload[TEASER_CONTRACT.turnstileTokenField] as string | undefined) ?? "";
    const remoteip = request.headers.get("CF-Connecting-IP");

    const turnstileOk = await verifyTurnstile(
      token,
      env.TURNSTILE_SECRET_KEY,
      remoteip,
    );
    if (!turnstileOk) {
      return Response.json(
        { ok: false, error: "turnstile failed" },
        { status: STATUS.turnstileRejected, headers: cors },
      );
    }

    const validation = validate(payload);
    if (!validation.ok) {
      return Response.json(
        { ok: false, errors: validation.errors },
        { status: STATUS.badRequest, headers: cors },
      );
    }

    const submittedAt = new Date().toISOString();
    const id = `${submittedAt}-${crypto.randomUUID().slice(0, 8)}`;

    const auditEntry = {
      id,
      submitted_at: submittedAt,
      remoteip,
      user_agent: request.headers.get("User-Agent"),
      submission: validation.data,
    };

    // KV write happens BEFORE the email so the lead survives a Brevo outage.
    // 1-year TTL (documented in CLAUDE.md "Where submissions go" — keep in sync).
    await env.FORM_LOG.put(id, JSON.stringify(auditEntry), {
      expirationTtl: 60 * 60 * 24 * 365, // 1 year
    });

    try {
      await sendEmail(env, validation.data, {
        id,
        remoteip,
        userAgent: request.headers.get("User-Agent"),
      });
    } catch (err) {
      // Submission is logged to KV even if email fails — Eric can pull from there.
      console.error("email send failed", err);
      return Response.json(
        { ok: true, warning: "submission saved but email delivery failed; will retry" },
        { status: STATUS.savedButEmailFailed, headers: cors },
      );
    }

    return Response.json({ ok: true, id }, { status: STATUS.ok, headers: cors });
  },
} satisfies ExportedHandler<Env>;
