/**
 * I5 exactly-once: at most one start call per attributed intent and per
 * idempotency key, and every start call carries a key. Intent attribution is
 * exchange -> intent; a start call attributable to no exchange is a violation.
 * Parallel duplicates are out of scope (the runner is sequential).
 */
import { intentIdOfCoreCall, startCalls } from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

export const exactlyOnce: Oracle = (o) => {
  const calls = startCalls(o);
  const violations: Violation[] = [];
  const seenIntents = new Set<string>();
  const seenKeys = new Set<string>();
  for (const call of calls) {
    const intentId = intentIdOfCoreCall(o, call.index);
    if (intentId === null) {
      violations.push(
        violation("I5", "start call is attributable to no intent", {
          coreCallIndex: call.index,
        }),
      );
    } else if (seenIntents.has(intentId)) {
      violations.push(
        violation("I5", "more than one start call for one intent", {
          coreCallIndex: call.index,
          intentId,
        }),
      );
    } else {
      seenIntents.add(intentId);
    }
    if (call.idempotencyKey === undefined) {
      violations.push(
        violation("I5", "start call has no idempotency key", {
          coreCallIndex: call.index,
          intentId,
        }),
      );
    } else if (seenKeys.has(call.idempotencyKey)) {
      violations.push(
        violation("I5", "more than one start call shares an idempotency key", {
          coreCallIndex: call.index,
          intentId,
        }),
      );
    } else {
      seenKeys.add(call.idempotencyKey);
    }
  }
  return {
    id: "I5",
    title: "Exactly-once execution",
    subjects: calls.length,
    violations,
  };
};
