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
