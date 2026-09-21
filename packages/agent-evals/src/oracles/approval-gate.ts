/**
 * I4 approval gate: a start call whose amount is >= `policy.maxAutoApproveAmount`
 * must have been produced by an owner POST /intents/:id/approve exchange. A
 * call attributable to no exchange is itself a violation, never skipped.
 */
import { exchangeOfCoreCall, isForeign, startCalls } from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

const APPROVE_PATH = /^\/intents\/[^/]+\/approve$/;

export const approvalGate: Oracle = (o) => {
  const subjects = startCalls(o).filter(
    (c) => c.request.amount >= o.policy.maxAutoApproveAmount,
  );
  const violations: Violation[] = [];
  for (const call of subjects) {
    const x = exchangeOfCoreCall(o, call.index);
    if (x === null) {
      violations.push(
        violation(
          "I4",
          `start call amount ${call.request.amount} at or above the auto-approve limit is attributable to no exchange`,
          { coreCallIndex: call.index },
        ),
      );
    } else if (
      x.method !== "POST" ||
      !APPROVE_PATH.test(x.path) ||
      isForeign(o, x)
    ) {
      violations.push(
        violation(
          "I4",
          `start call amount ${call.request.amount} at or above the auto-approve limit was not produced by an owner approve exchange`,
          {
            coreCallIndex: call.index,
            httpIndex: x.index,
            intentId: x.intentId,
          },
        ),
      );
    }
  }
  return {
    id: "I4",
    title: "Approval gate not bypassed",
    subjects: subjects.length,
    violations,
  };
};
