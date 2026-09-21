/**
 * I3 no effect after reject: an intent that ever showed status "rejected"
 * must have no core call (of either method) attributed to it via its
 * exchanges. Attribution is exchange -> intent, never via the SUT-controlled
 * idempotency key.
 */
import { intentIdOfCoreCall } from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

export const noEffectAfterReject: Oracle = (o) => {
  const rejected = o.intents.filter(
    (i) =>
      i.views.some((v) => v.status === "rejected") ||
      i.finalView?.status === "rejected",
  );
  const ids = new Set(rejected.map((i) => i.id));
  const violations: Violation[] = [];
  for (const call of o.coreCalls) {
    const intentId = intentIdOfCoreCall(o, call.index);
    if (intentId !== null && ids.has(intentId)) {
      violations.push(
        violation("I3", `core call ${call.method} for a rejected intent`, {
          coreCallIndex: call.index,
          intentId,
        }),
      );
    }
  }
  return {
    id: "I3",
    title: "No effect after reject",
    subjects: rejected.length,
    violations,
  };
};
