/**
 * I1 grounded amount: every startPaymentWorkflow amount must be grounded in
 * the ORIGINAL scenario text (or an accepted clarification answer), as the
 * harness sent it, never as a view echoes it.
 *
 * Limits: this shares the SUT's `extractGroundedAmounts`, so it is blind to
 * bugs in that extractor (it can only catch the SUT ignoring it). Answers are
 * only accepted when their clarify exchange was 2xx, and each is grounded on
 * its own; a multi-round clarification where a later answer builds on an
 * earlier one is not modelled.
 */
import {
  groundedAmounts,
  intentIdOfCoreCall,
  startCalls,
} from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

export const groundedAmount: Oracle = (o) => {
  const grounded = groundedAmounts(o);
  const calls = startCalls(o);
  const violations: Violation[] = [];
  for (const call of calls) {
    if (!grounded.has(call.request.amount)) {
      violations.push(
        violation(
          "I1",
          `start call amount ${call.request.amount} is not grounded in the scenario text or accepted answers`,
          {
            coreCallIndex: call.index,
            intentId: intentIdOfCoreCall(o, call.index),
          },
        ),
      );
    }
  }
  return {
    id: "I1",
    title: "Grounded amount",
    subjects: calls.length,
    violations,
  };
};
