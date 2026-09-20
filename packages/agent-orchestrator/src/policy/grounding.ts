export const MINOR_UNIT_EXPONENT = 2;

const NUMBER_LITERAL = /\d[\d,]*(?:\.\d+)?/g;
const GROUPED_INT_PART = /^\d{1,3}(?:,\d{3})+$/;
const PLAIN_INT_PART = /^\d+$/;

/**
 * Every numeric literal in `text`, normalised to integer minor units.
 * "1200" → 120000 · "1200.50" → 120050 · "1,200.50" → 120050
 *
 * Deliberately strict, not NLU-level (spec §13 scopes that out):
 *  - a malformed thousands-grouping ("1,20") is SKIPPED, never guessed
 *  - more than 2 fraction digits is SKIPPED (not a 2-decimal money amount)
 *  - a date or reference number in the text WILL ground spurious amounts —
 *    this function is a fabrication guard, not a correctness guard; the
 *    policy layer's amount thresholds are the defense-in-depth behind it
 *  - European formatting ("1.200,50") is NOT supported in v1
 */
export function extractGroundedAmounts(text: string): ReadonlySet<number> {
  const amounts = new Set<number>();
  for (const match of text.matchAll(NUMBER_LITERAL)) {
    const literal = match[0];
    const dotIndex = literal.indexOf(".");
    const intPart = dotIndex === -1 ? literal : literal.slice(0, dotIndex);
    const fracPart = dotIndex === -1 ? undefined : literal.slice(dotIndex + 1);

    const isGrouped = intPart.includes(",");
    if (
      isGrouped
        ? !GROUPED_INT_PART.test(intPart)
        : !PLAIN_INT_PART.test(intPart)
    ) {
      continue;
    }
    if (fracPart !== undefined && fracPart.length > MINOR_UNIT_EXPONENT) {
      continue;
    }

    const minor =
      Number(intPart.replaceAll(",", "")) * 100 +
      Number((fracPart ?? "").padEnd(MINOR_UNIT_EXPONENT, "0"));
    if (!Number.isSafeInteger(minor)) {
      continue;
    }
    amounts.add(minor);
  }
  return amounts;
}

// Mirrors agent-proposal.ts's private MERCHANT_ID charset (same precedent as
// anthropic-tools.ts): everything outside it separates tokens.
const MERCHANT_TOKEN_SEPARATOR = /[^A-Za-z0-9_-]+/;
const HAS_LETTER = /[A-Za-z]/;

/**
 * Every candidate PAYEE token in `text`, lower-cased. Split on everything
 * outside [A-Za-z0-9_-] (exactly agent-proposal.ts's private MERCHANT_ID
 * charset) so an id is compared as a WHOLE token, never a substring.
 * "Pay Acme-Corp $10.00" -> {"pay","acme-corp"} ("10"/"00" dropped).
 *
 * Tokens containing no ASCII letter are EXCLUDED (`42`, `-`, `_`, `4-2`):
 * every payment text contains its amount as digits, so else merchantId "120"
 * would always be grounded in "Pay $120 to acme" (payee-side mirror of the
 * documented reference-number quirk in `extractGroundedAmounts`). Ordinary
 * prose also contains bare `-`/`_`, which would otherwise ground a
 * merchantId of literally `-`.
 *
 * Total: never throws, empty set for empty text.
 */
export function extractGroundedMerchantTokens(
  text: string,
): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const raw of text.split(MERCHANT_TOKEN_SEPARATOR)) {
    if (raw === "" || !HAS_LETTER.test(raw)) {
      continue;
    }
    tokens.add(raw.toLowerCase());
  }
  return tokens;
}
