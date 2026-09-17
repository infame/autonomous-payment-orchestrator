import { z } from "zod";
import type { AgentProposal } from "../domain/agent-proposal.js";
import { declineProposal } from "../domain/agent-proposal.js";
import { IntentNotFoundError } from "../domain/errors.js";
import { MAX_CLARIFICATION_ANSWER_LENGTH } from "../domain/intent.js";
import type { PolicyConfig } from "../policy/rules.js";
import { resolvePolicyConfig } from "../policy/rules.js";
import type { PolicyVerdict } from "../policy/verdict.js";
import type { LlmClient } from "../ports/llm-client.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import { applyPolicy } from "./apply-policy.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const AnswerClarificationCommand = z.object({
  intentId: z.string().min(1),
  answer: z
    .string()
    .min(1)
    .max(MAX_CLARIFICATION_ANSWER_LENGTH)
    .refine((s) => s.trim().length > 0, {
      message: "answer must not be blank",
    }),
});
export type AnswerClarificationCommand = z.infer<
  typeof AnswerClarificationCommand
>;

export interface AnswerClarificationResult {
  readonly intent: IntentView;
  /** `null` only when policy was never reached (a `clarify`/`decline` agent outcome). */
  readonly verdict: PolicyVerdict | null;
}

/**
 * A second `clarify` from the LLM has nowhere legal to go (spec §3.1's
 * "only one round" rule) — it is mapped to a synthetic decline instead of
 * being surfaced as-is. The reason string here is FIXED, never built from
 * the model's actual second `question` — echoing LLM-authored free text
 * derived from customer input into a persisted/loggable field via this
 * unusual path would be exactly the kind of leak this codebase's error/
 * decline messages are required to avoid (see this file's own module-level
 * warning below, and `domain/agent-proposal.ts`'s header).
 */
const SYNTHETIC_SECOND_CLARIFICATION_DECLINE = declineProposal(
  "The clarification answer did not resolve the ambiguity, and only one clarification round is allowed.",
);

/**
 * Resolve a pending clarification: record the customer's answer, re-ask the
 * `LlmClient` with it in hand, and route the resulting `AgentProposal`
 * exactly like `SubmitIntent` does — through `applyPolicy` on a
 * `propose_payment` outcome, or straight to a terminal state otherwise.
 *
 * ## Reachable outcomes
 *
 * Exactly three statuses are reachable through this use-case: `proposed`
 * (policy allowed the now-answered proposal), `needs_approval` (policy gated
 * it), and `rejected` (the agent declined outright, policy hard-rejected it,
 * or the second call also came back `clarify` — see below). Never
 * `needs_clarification` again: spec §3.1 allows exactly one round, and
 * `Intent`'s state machine has no transition back into it.
 *
 * ## Why `recordClarificationAnswer` runs BEFORE the LLM call
 *
 * This is deliberate, not just "fail fast for efficiency." `Intent.propose`
 * legally accepts BOTH `received` and `needs_clarification` as a starting
 * status (an LLM can resolve an intent unambiguously on its very first
 * pass). If this use-case relied on `propose()`'s own guard to reject a
 * wrong-status intent, answering a clarification question that was never
 * asked (an intent still sitting at `received`) would silently succeed as a
 * plain `received → proposed` transition, instead of correctly failing.
 * `Intent.recordClarificationAnswer`'s own guard only accepts
 * `needs_clarification`, so calling it first — and reading the answer back
 * off the aggregate (`intent.clarificationAnswer`), not off `command`, when
 * building the `LlmClient` request — is what correctly rejects that case.
 *
 * ## Second `clarify` → synthetic decline, never echoing the model's question
 *
 * If the LLM's second-round proposal is itself `clarify`, there is no legal
 * status for that — it's mapped to a fixed, hardcoded decline
 * (`SYNTHETIC_SECOND_CLARIFICATION_DECLINE`, module-level, above) instead of
 * being passed through. The synthetic reason NEVER derives from the model's
 * actual `question` text on that second attempt.
 *
 * ## Exactly one repository write
 *
 * This method calls `this.repo.update(intent, stored.version)` exactly
 * once, at the end, after every domain transition (including
 * `recordClarificationAnswer` itself) has already happened on the
 * in-memory `intent` instance.
 *
 * ## No retry on `IntentVersionConflictError`
 *
 * A version conflict from that single `update()` call propagates uncaught
 * — there is no retry loop. The only realistic trigger is two concurrent
 * `AnswerClarification` calls for the same intent; nothing else in this
 * codebase mutates a `needs_clarification` intent concurrently. A retry
 * would just re-`findById`, find the intent already moved on by the winner
 * (no longer `needs_clarification`), and throw `InvalidIntentStateError`
 * after wastefully paying for a second LLM call — converting one error into
 * another, never succeeding.
 */
export class AnswerClarification {
  private readonly policyConfig: PolicyConfig;

  constructor(
    private readonly repo: IntentRepository,
    private readonly llm: LlmClient,
    policyConfig: Partial<PolicyConfig> = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    // Fail fast on a bad config at construction time, not on the first request.
    this.policyConfig = resolvePolicyConfig(policyConfig);
  }

  async execute(
    raw: AnswerClarificationCommand,
  ): Promise<AnswerClarificationResult> {
    const command = AnswerClarificationCommand.parse(raw);
    const now = this.clock();
    const stored = await this.repo.findById(command.intentId);
    if (!stored) {
      throw new IntentNotFoundError(command.intentId);
    }
    const intent = stored.intent;

    // BEFORE the LLM call — see class header for why this, not `propose()`'s
    // own guard, is what must reject a wrong-status intent.
    intent.recordClarificationAnswer(command.answer, now);

    const proposal = await this.llm.reason({
      intentText: intent.text,
      clarificationAnswer: intent.clarificationAnswer,
    });

    let verdict: PolicyVerdict | null = null;
    switch (proposal.kind) {
      case "propose_payment": {
        intent.propose(proposal, now);
        verdict = await applyPolicy(
          intent,
          proposal,
          { repo: this.repo, config: this.policyConfig },
          now,
        );
        break;
      }
      case "decline":
        intent.declineByAgent(proposal, now);
        break;
      case "clarify":
        // Fixed, hardcoded reason — never the model's actual `question`
        // text from this second attempt. See class + module header.
        intent.declineByAgent(SYNTHETIC_SECOND_CLARIFICATION_DECLINE, now);
        break;
      default: {
        const exhaustive: never = proposal;
        // Never stringify the full proposal here — it may carry LLM-authored
        // free text (reasoning/question/reason) derived from customer input.
        // Only the structural discriminator is safe to put in an error message.
        throw new Error(
          `Unhandled AgentProposal kind: ${String((exhaustive as AgentProposal).kind)}`,
        );
      }
    }

    const updated = await this.repo.update(intent, stored.version);
    return { intent: toIntentView(updated.intent), verdict };
  }
}
