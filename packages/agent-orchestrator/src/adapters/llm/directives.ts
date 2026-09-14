/**
 * Directive grammar for `MockLlmClient` — how a demo caller steers the mock
 * without a real model. Unlike `pay-core`'s `SimulatorProvider`, whose
 * directives ride inside an OPAQUE carrier string the port already treats as
 * a vendor-defined token (`paymentMethodToken`/`providerRef`; see
 * `packages/pay-core/src/adapters/simulator/directives.ts`), this grammar is
 * scanned out of `intentText`/`clarificationAnswer` — plain natural-language
 * text a real end user (or a prompt-injection attempt) also writes into.
 * That's why directives here are found ANYWHERE in the string (mid-prose),
 * not only as the whole value, and why every verb/arg is validated before
 * being trusted: `parseDirectives` must behave exactly as safely on
 * `"sim.declineinsurance"` or a paragraph of unrelated prose as it does on a
 * deliberately crafted directive.
 *
 * **Totality contract, matching `parseDirective`'s in pay-core exactly**:
 * `parseDirectives` must NEVER throw, for any input, including `""`, prose
 * with no directives at all, malformed directives, wrong-case directives, or
 * directives embedded inside other words. Unknown verbs and unknown/invalid
 * args are silently ignored, never rejected with an error — the caller
 * (`MockLlmClient.reason`) always gets a well-formed `ParsedDirectives` back
 * and decides what to do with a `null` field itself.
 */

export type AmountSelector = "min" | "max" | "ungrounded";

export type MockOutcome =
  | { readonly kind: "payment"; readonly selector: AmountSelector }
  | { readonly kind: "clarify"; readonly slug: string }
  | { readonly kind: "decline"; readonly slug: string }
  | { readonly kind: "unavailable" };

export interface ParsedDirectives {
  readonly outcome: MockOutcome | null;
  readonly currency: string | null;
  readonly merchantId: string | null;
}

/**
 * `sim.<verb>` optionally followed by `.<arg>`. Deliberately digit-free at
 * the grammar level: `sim.amount.<selector>` never carries a literal amount
 * — see `mock-llm-client.ts`'s header for why. Verb is lowercase-only
 * (case-sensitive match, per the grammar table); arg allows the same
 * alphanumeric/`_`/`-` charset `agent-proposal.ts` already uses for
 * `merchantId`.
 */
const DIRECTIVE = /sim\.([a-z_]+)(?:\.([A-Za-z0-9_-]+))?/g;

const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_DECLINE_SLUG = "unsupported_request";
const DEFAULT_CLARIFY_SLUG = "amount";

/**
 * Total: scans `text` for every `sim.*` directive and folds them into one
 * `ParsedDirectives`. Within the outcome field, precedence among distinct
 * directive KINDS is fixed regardless of where each appears in the text:
 * `unavailable` > `decline` > `clarify` > `amount.*`. Among multiple
 * directives of the SAME kind (e.g. two `sim.decline.*`), or multiple
 * `sim.currency.*`/`sim.merchant.*`, the first one with a valid arg wins;
 * later ones are ignored. An unknown verb, or a known verb with an
 * arg that fails its own validation, contributes nothing — it never bumps
 * out an outcome or field that a different, valid directive already set.
 */
export function parseDirectives(text: string): ParsedDirectives {
  let unavailable = false;
  let declineSlug: string | null = null;
  let clarifySlug: string | null = null;
  let amountSelector: AmountSelector | null = null;
  let currency: string | null = null;
  let merchantId: string | null = null;

  for (const match of text.matchAll(DIRECTIVE)) {
    const verb = match[1] ?? "";
    const arg = match[2];

    switch (verb) {
      case "unavailable":
        unavailable = true;
        break;
      case "decline":
        if (declineSlug === null) {
          declineSlug =
            arg !== undefined && SLUG.test(arg) ? arg : DEFAULT_DECLINE_SLUG;
        }
        break;
      case "clarify":
        if (clarifySlug === null) {
          clarifySlug =
            arg !== undefined && SLUG.test(arg) ? arg : DEFAULT_CLARIFY_SLUG;
        }
        break;
      case "amount":
        if (
          amountSelector === null &&
          (arg === "min" || arg === "max" || arg === "ungrounded")
        ) {
          amountSelector = arg;
        }
        break;
      case "currency":
        if (currency === null && arg !== undefined && CURRENCY_CODE.test(arg)) {
          currency = arg;
        }
        break;
      case "merchant":
        if (merchantId === null && arg !== undefined && MERCHANT_ID.test(arg)) {
          merchantId = arg;
        }
        break;
      default:
        break;
    }
  }

  const outcome: MockOutcome | null = unavailable
    ? { kind: "unavailable" }
    : declineSlug !== null
      ? { kind: "decline", slug: declineSlug }
      : clarifySlug !== null
        ? { kind: "clarify", slug: clarifySlug }
        : amountSelector !== null
          ? { kind: "payment", selector: amountSelector }
          : null;

  return { outcome, currency, merchantId };
}

/**
 * Combines a directive parse of the clarification answer with one of the
 * original intent text, field by field: `answer`'s value wins when present
 * (a user's reply is the most recent, most specific instruction), otherwise
 * falls through to `text`'s value, otherwise `null`. Mirrors
 * `evaluatePolicy`'s own text-then-answer union, but per-field rather than
 * unioning a set — an outcome/currency/merchant only makes sense as a single
 * chosen value, not a combined set.
 */
export function mergeDirectives(
  answer: ParsedDirectives,
  text: ParsedDirectives,
): ParsedDirectives {
  return {
    outcome: answer.outcome ?? text.outcome,
    currency: answer.currency ?? text.currency,
    merchantId: answer.merchantId ?? text.merchantId,
  };
}
