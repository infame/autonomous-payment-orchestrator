import type { PaymentProposal } from "../domain/agent-proposal.js";
import type { Intent } from "../domain/intent.js";
import { evaluatePolicy } from "../policy/evaluate-policy.js";
import { DAILY_WINDOW_MS, type PolicyConfig } from "../policy/rules.js";
import type { PolicyVerdict } from "../policy/verdict.js";
import type { IntentRepository } from "../ports/intent-repository.js";

/**
 * The single source of `PolicyContext` wiring — every caller that runs
 * policy against a `PaymentProposal` goes through here, so a future caller
 * can't forget to include `intent.clarificationAnswer` in grounding, which
 * would incorrectly hard-reject an amount the user legitimately supplied in
 * their clarification answer (see `policy/evaluate-policy.ts`'s own
 * `PolicyContext.clarificationAnswer` and `Intent.recordClarificationAnswer`'s
 * header for why that field widens the grounded set by design).
 *
 * Performs NO repository write beyond the `countCompletedSince` read — the
 * caller owns persistence. It also mutates `intent` in place on a
 * `needs_approval`/`reject` verdict (`requireApproval`/`rejectByPolicy`).
 *
 * ## Why an `allow` verdict is not persisted
 *
 * On `allow`, `intent` is left untouched (stays `proposed`, `policyVerdict`
 * stays `null`) rather than being written back through some `allowIntent`
 * call. The daily rate limit (`policy/rules.ts`'s `dailyRateLimit` rule) is
 * time-dependent: a stored `allow` verdict from this moment would be stale by
 * the time a future claim/execute use-case actually moves money, since more
 * of the customer's intents may have completed in between. Policy must be
 * re-evaluated at claim/execute time regardless — so persisting today's
 * `allow` here would create a verdict that looks authoritative but isn't.
 * Every caller of `applyPolicy` (`SubmitIntent`, `AnswerClarification`)
 * inherits this behaviour for free.
 */
export interface PolicyDependencies {
  /** Only `countCompletedSince` is used. */
  readonly repo: IntentRepository;
  /** Already resolved via `resolvePolicyConfig`. */
  readonly config: PolicyConfig;
}

export async function applyPolicy(
  intent: Intent,
  proposal: PaymentProposal,
  deps: PolicyDependencies,
  now: Date,
): Promise<PolicyVerdict> {
  const completedIntentsLast24h = await deps.repo.countCompletedSince(
    intent.customerId,
    new Date(now.getTime() - DAILY_WINDOW_MS),
  );
  const verdict = evaluatePolicy(proposal, {
    intentText: intent.text,
    clarificationAnswer: intent.clarificationAnswer,
    completedIntentsLast24h,
    config: deps.config,
  });
  if (verdict.decision === "needs_approval") {
    intent.requireApproval(verdict, now);
  } else if (verdict.decision === "reject") {
    intent.rejectByPolicy(verdict, now);
  }
  // "allow": intent stays "proposed" — the verdict is deliberately NOT
  // persisted onto the intent. See this file's header.
  return verdict;
}
