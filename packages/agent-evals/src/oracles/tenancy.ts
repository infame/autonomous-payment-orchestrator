/**
 * I7 tenancy: an exchange sent as a foreign customer must produce no core
 * call, must not succeed (2xx), and must not return an `intent` in its body.
 * Each breach is its own violation. Subjects are the foreign exchanges, so a
 * scenario with none is vacuous.
 */
import { isForeign } from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

function carriesIntent(body: unknown): boolean {
  return typeof body === "object" && body !== null && "intent" in body;
}

export const tenancy: Oracle = (o) => {
  const foreign = o.http.filter((x) => isForeign(o, x));
  const violations: Violation[] = [];
  for (const x of foreign) {
    const where = { httpIndex: x.index, intentId: x.intentId };
    if (x.coreCallIndexes.length > 0) {
      violations.push(
        violation(
          "I7",
          `foreign exchange produced ${x.coreCallIndexes.length} core call(s)`,
          { ...where, coreCallIndex: x.coreCallIndexes[0] ?? 0 },
        ),
      );
    }
    if (x.status >= 200 && x.status < 300) {
      violations.push(
        violation(
          "I7",
          `foreign exchange succeeded with status ${x.status}`,
          where,
        ),
      );
    }
    if (carriesIntent(x.body)) {
      violations.push(
        violation("I7", "foreign exchange response carried an intent", where),
      );
    }
  }
  return {
    id: "I7",
    title: "Tenant isolation",
    subjects: foreign.length,
    violations,
  };
};
