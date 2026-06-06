/**
 * gr8gray-forms — Cloudflare Worker
 *
 * Receives teaser-form submissions from gr8gray.dev, validates them
 * (Turnstile + schema), writes an audit log to KV, and emails Eric via Brevo.
 *
 * Phase A scope only — no Claude API integration, no SOW generation.
 */

export interface Env {
  FORM_LOG: KVNamespace;
  BREVO_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  NOTIFY_TO: string;
  NOTIFY_FROM: string;
}

const DEADLINE_VALUES = ["hard", "soft", "flexible"] as const;
const BUDGET_VALUES = [
  "lt2k",
  "2to5k",
  "5to10k",
  "10to25k",
  "gt25k",
  "unsure",
] as const;

const ORIGIN_ALLOWLIST = new Set([
  "https://gr8gray.dev",
  "https://www.gr8gray.dev",
  "http://localhost:4321",
]);

type FieldError = { field: string; reason: string };

type TeaserSubmission = {
  name_email: string;
  one_liner: string;
  success_metric: string;
  deadline: (typeof DEADLINE_VALUES)[number];
  budget: (typeof BUDGET_VALUES)[number];
  examples: string;
};

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ORIGIN_ALLOWLIST.has(origin) ? origin : "https://gr8gray.dev";
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
    name_email: strField("name_email", 200),
    one_liner: strField("one_liner", 500),
    success_metric: strField("success_metric", 500),
    deadline: enumField("deadline", DEADLINE_VALUES),
    budget: enumField("budget", BUDGET_VALUES),
    examples: strField("examples", 1000),
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
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/teaser" || request.method !== "POST") {
      return new Response("not found", { status: 404, headers: cors });
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { ok: false, error: "invalid json" },
        { status: 400, headers: cors },
      );
    }

    const token =
      (payload["cf-turnstile-response"] as string | undefined) ?? "";
    const remoteip = request.headers.get("CF-Connecting-IP");

    const turnstileOk = await verifyTurnstile(
      token,
      env.TURNSTILE_SECRET_KEY,
      remoteip,
    );
    if (!turnstileOk) {
      return Response.json(
        { ok: false, error: "turnstile failed" },
        { status: 403, headers: cors },
      );
    }

    const validation = validate(payload);
    if (!validation.ok) {
      return Response.json(
        { ok: false, errors: validation.errors },
        { status: 400, headers: cors },
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

    // KV write is best-effort — don't fail the request if it's slow.
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
        { status: 202, headers: cors },
      );
    }

    return Response.json({ ok: true, id }, { status: 200, headers: cors });
  },
} satisfies ExportedHandler<Env>;
