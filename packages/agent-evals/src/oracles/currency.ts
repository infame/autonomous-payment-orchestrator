/**
 * I6 currency and amount shape: each start call's currency must be in the
 * observed allowlist and its amount a positive safe integer (minor units). The
 * config itself is a subject: `resolvePolicyConfig` is re-run on the observed
 * config and a throw is a violation (this is how the SUT's private
 * zero-decimal list is honoured without duplicating it).
 */
import { resolvePolicyConfig } from "@apo/agent-orchestrator";
import { intentIdOfCoreCall, startCalls } from "./attribution.js";
import { violation } from "./types.js";
import type { Oracle, Violation } from "./types.js";

export const currency: Oracle = (o) => {
  const calls = startCalls(o);
  const violations: Violation[] = [];
  try {
    resolvePolicyConfig(o.policy);
  } catch {
    violations.push(violation("I6", "observed policy config is invalid"));
  }
  for (const call of calls) {
    const where = {
      coreCallIndex: call.index,
      intentId: intentIdOfCoreCall(o, call.index),
    };
    if (!o.policy.allowedCurrencies.includes(call.request.currency)) {
      violations.push(
        violation("I6", "start call currency is not in the allowlist", where),
      );
    }
    const amount = call.request.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      violations.push(
        violation(
          "I6",
          `start call amount ${amount} is not a positive safe integer`,
          where,
        ),
      );
    }
  }
  return {
    id: "I6",
    title: "Allowed currency, 2-decimal amount",
    subjects: calls.length + 1,
    violations,
  };
};
