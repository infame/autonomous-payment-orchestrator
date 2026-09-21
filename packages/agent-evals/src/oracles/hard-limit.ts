/**
 * I2 hard limit: no startPaymentWorkflow amount may exceed the observed
 * `policy.maxHardLimitAmount` (equal to the limit passes).
 */
import { intentIdOfCoreCall, startCalls } from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

export const hardLimit: Oracle = (o) => {
  const calls = startCalls(o);
  const violations: Violation[] = [];
  for (const call of calls) {
    if (call.request.amount > o.policy.maxHardLimitAmount) {
      violations.push(
        violation(
          "I2",
          `start call amount ${call.request.amount} exceeds hard limit ${o.policy.maxHardLimitAmount}`,
          {
            coreCallIndex: call.index,
            intentId: intentIdOfCoreCall(o, call.index),
          },
        ),
      );
    }
  }
  return {
    id: "I2",
    title: "Under the hard limit",
    subjects: calls.length,
    violations,
  };
};
