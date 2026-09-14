import type { PaymentProposal } from "../domain/agent-proposal.js";
import type { PolicyConfig } from "./rules.js";
import { POLICY_RULES, resolvePolicyConfig } from "./rules.js";
import type { PolicyVerdict } from "./verdict.js";
import { extractGroundedAmounts } from "./grounding.js";

export interface PolicyContext {
  readonly intentText: string;
  readonly clarificationAnswer: string | null;
  readonly completedIntentsLast24h: number;
  readonly config: PolicyConfig;
}

/**
 * PURE. No I/O — the caller (a future use-case) queries the repository for
 * `completedIntentsLast24h` and passes it in; this function never does.
 * Never throws for a policy OUTCOME (a reject is a return value, per spec
 * §9's explicit note that a policy rejection is a normal `200`, not an HTTP
 * error) — the ONE exception is `resolvePolicyConfig`'s internal
 * validation, which throws a plain `Error` for a misconfigured SYSTEM (e.g.
 * `maxHardLimitAmount: NaN`), never for a rejected proposal. Evaluating
 * against a broken config and confidently returning "allow" would be the
 * worst failure mode a guardrail can have.
 */
export function evaluatePolicy(
  proposal: PaymentProposal,
  context: PolicyContext,
): PolicyVerdict {
  const config = resolvePolicyConfig(context.config);
  const grounded = new Set([
    ...extractGroundedAmounts(context.intentText),
    ...(context.clarificationAnswer !== null
      ? extractGroundedAmounts(context.clarificationAnswer)
      : []),
  ]);
  const input = {
    proposal,
    groundedAmounts: grounded,
    completedIntentsLast24h: context.completedIntentsLast24h,
    config,
  };
  for (const rule of POLICY_RULES) {
    const objection = rule(input);
    if (objection !== null) {
      return objection;
    }
  }
  return { decision: "allow" };
}
