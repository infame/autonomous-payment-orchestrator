import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentProposal } from "../domain/agent-proposal.js";
import {
  CUSTOMER_ID_PATTERN,
  Intent,
  MAX_INTENT_TEXT_LENGTH,
} from "../domain/intent.js";
import { evaluatePolicy } from "../policy/evaluate-policy.js";
import type { PolicyConfig } from "../policy/rules.js";
import { resolvePolicyConfig } from "../policy/rules.js";
import type { PolicyVerdict } from "../policy/verdict.js";
import type { LlmClient } from "../ports/llm-client.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const SubmitIntentCommand = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_INTENT_TEXT_LENGTH)
    .refine((s) => s.trim().length > 0, { message: "text must not be blank" }),
  customerId: z.string().regex(CUSTOMER_ID_PATTERN),
});
export type SubmitIntentCommand = z.infer<typeof SubmitIntentCommand>;

export interface SubmitIntentResult {
  readonly intent: IntentView;
  /**
   * `null` only when policy was never reached (a `clarify`/`decline` agent
   * outcome). On `propose_payment` this always carries the verdict,
   * including "allow" — which is deliberately not persisted onto the
   * intent, see this class's header.
   */
  readonly verdict: PolicyVerdict | null;
}

/** Trailing window `countCompletedSince` is queried over. Module-level, not an inline literal. */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Submit a brand-new natural-language intent: create it, ask the `LlmClient`
 * to reason about it once, and — when the agent proposes a payment — run the
 * deterministic policy layer against that proposal.
 *
 * ## Reachable outcomes
 *
 * Exactly four statuses are reachable through this use-case:
 * `needs_clarification` (agent asked a clarifying question), `proposed`
 * (agent proposed a payment and policy allowed it — see below on why an
 * `allow` verdict isn't persisted), `needs_approval` (policy gated the
 * proposal), and `rejected` (agent declined outright, or policy hard-rejected
 * it). `executing` is NOT reachable from this use-case: that requires an
 * `autoApprove`/`approve` call carrying a `durableLedgerEventId` minted by an
 * `AgentCoreClient` call, which is not wired into this slice.
 *
 * ## Why an `allow` verdict is not persisted
 *
 * The daily rate limit (`policy/rules.ts`'s `dailyRateLimit` rule) is
 * time-dependent: a stored `allow` verdict from this moment would be stale by
 * the time a future claim/execute use-case actually moves money, since more
 * of the customer's intents may have completed in between. Policy must be
 * re-evaluated at claim/execute time regardless, in a future slice — so
 * persisting today's `allow` here would create a verdict that looks
 * authoritative but isn't. The intent instead stays `proposed`, with
 * `policyVerdict` still `null`, exactly as if policy had not run yet.
 *
 * ## Exactly one repository write
 *
 * This method calls `this.repo.create(intent)` exactly once, at the end,
 * after every domain transition has already happened on the in-memory
 * `intent` instance. It never calls `this.repo.update()` — there is no
 * version to conflict on, since this is a freshly-created aggregate that has
 * not yet been persisted.
 *
 * ## Why it's safe to call the LLM before that write
 *
 * `LlmClient.reason` moves no money and has no durable side effect of its
 * own — unlike the concern `ports/intent-repository.ts`'s header raises for
 * a FUTURE approve-and-execute use-case (which must claim the intent BEFORE
 * calling `durable-ledger`, because a durable-ledger call has to be claimed
 * against exactly once), there is nothing here that a "claim first" pattern
 * would protect. The accepted tradeoff is the mirror image: if the LLM call
 * fails, this method leaves no persisted row at all. That's fine — there's
 * no orphan `received` row left behind, and nothing in this or the next
 * slice could resume a half-submitted intent anyway.
 */
export class SubmitIntent {
  private readonly policyConfig: PolicyConfig;

  constructor(
    private readonly repo: IntentRepository,
    private readonly llm: LlmClient,
    policyConfig: Partial<PolicyConfig> = {},
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID(),
  ) {
    // Fail fast on a bad config at construction time, not on the first request.
    this.policyConfig = resolvePolicyConfig(policyConfig);
  }

  async execute(raw: SubmitIntentCommand): Promise<SubmitIntentResult> {
    const command = SubmitIntentCommand.parse(raw);
    const now = this.clock();
    const intent = Intent.submit({
      id: this.newId(),
      customerId: command.customerId,
      text: command.text,
      now,
    });

    const proposal = await this.llm.reason({
      intentText: intent.text,
      clarificationAnswer: null,
    });

    let verdict: PolicyVerdict | null = null;
    switch (proposal.kind) {
      case "clarify":
        intent.clarify(proposal, now);
        break;
      case "decline":
        intent.declineByAgent(proposal, now);
        break;
      case "propose_payment": {
        intent.propose(proposal, now);
        const completedIntentsLast24h = await this.repo.countCompletedSince(
          intent.customerId,
          new Date(now.getTime() - DAILY_WINDOW_MS),
        );
        verdict = evaluatePolicy(proposal, {
          intentText: intent.text,
          clarificationAnswer: null,
          completedIntentsLast24h,
          config: this.policyConfig,
        });
        if (verdict.decision === "needs_approval") {
          intent.requireApproval(verdict, now);
        } else if (verdict.decision === "reject") {
          intent.rejectByPolicy(verdict, now);
        }
        // "allow": intent stays "proposed" — the verdict is deliberately NOT
        // persisted onto the intent. See class header.
        break;
      }
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

    const stored = await this.repo.create(intent);
    return { intent: toIntentView(stored.intent), verdict };
  }
}
