/**
 * contract.ts — THE WORKER HALF OF A TWO-REPO CONTRACT.
 *
 * The other half lives in the `gr8-gray/gr8gray-site` repo:
 *   gr8gray-site/src/lib/teaserContract.ts   (single source for the site)
 *     consumed by src/components/Contact.astro (form markup) and
 *     e2e/contact-form.spec.ts (asserts the rendered DOM matches it).
 *
 * Field names, max lengths, and enum values here MUST match that file
 * exactly — they change in LOCKSTEP. The repos cannot import each other;
 * this comment pair and the two e2e suites are the only guard. Drift means
 * production submissions 400 while the site still looks fine.
 *
 * validate() in src/index.ts reads everything from TEASER_CONTRACT — do not
 * re-introduce literals there.
 */

export const TEASER_CONTRACT = {
  /** The Worker's only route. Everything else 404s. */
  path: "/teaser",

  /** Max lengths for the free-text fields. The site mirrors these as
   * `maxlength` attributes, so the Worker rejecting one usually means the
   * two repos drifted. */
  fieldMax: {
    name_email: 200,
    one_liner: 500,
    success_metric: 500,
    examples: 1000,
  },

  /** Enum allowlists. Order matches the site's rendered <option> order.
   * Trap: budget value names are historical ("lt2k") while the site's labels
   * say $2.5K — the VALUES are the wire contract, labels are site copy. */
  enums: {
    deadline: ["hard", "soft", "flexible"],
    budget: ["lt2k", "2to5k", "5to10k", "10to25k", "gt25k", "unsure"],
  },

  /** Hidden field the Turnstile widget injects client-side; verified FIRST,
   * before validation, KV, or email — that ordering is what makes the e2e
   * suite side-effect-free (see CLAUDE.md "Testing safely"). */
  turnstileTokenField: "cf-turnstile-response",

  /** Response status contract — documented in CLAUDE.md/README.md and
   * handled by the site's inline submit script (it branches on r.ok only). */
  status: {
    ok: 200,
    savedButEmailFailed: 202,
    preflight: 204,
    badRequest: 400,
    turnstileRejected: 403,
    notFound: 404,
  },
} as const;

/** Fallback + canonical origin echoed when the request Origin isn't allowed. */
export const CANONICAL_SITE_ORIGIN = "https://gr8gray.dev";

/** Browser origins allowed to POST. Cross-repo trap that CANNOT be
 * single-sourced: every origin the site is actually served from (apex, www,
 * local dev) must be listed here or the browser silently blocks the form.
 * See gr8gray-site/CLAUDE.md "The site↔forms contract". */
export const ORIGIN_ALLOWLIST = [
  CANONICAL_SITE_ORIGIN,
  "https://www.gr8gray.dev",
  "http://localhost:4321",
] as const;

export type DeadlineValue = (typeof TEASER_CONTRACT.enums.deadline)[number];
export type BudgetValue = (typeof TEASER_CONTRACT.enums.budget)[number];
