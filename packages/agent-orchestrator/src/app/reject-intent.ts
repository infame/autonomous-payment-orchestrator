import { z } from "zod";
import { IntentNotFoundError } from "../domain/errors.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const RejectIntentCommand = z.object({
  intentId: z.string().min(1),
});
export type RejectIntentCommand = z.infer<typeof RejectIntentCommand>;

/**
 * Explicitly reject an intent that's sitting at a human approval gate.
 *
 * ## Reachable outcome
 *
 * Exactly one status is reachable through this use-case: `rejected`, from
 * exactly one legal source status, `needs_approval`. `Intent.rejectByApprover`
 * enforces this itself (`assertStatus(["needs_approval"], ...)`, throwing
 * `InvalidIntentStateError` otherwise) — this use-case adds no separate
 * wrong-status check of its own on top of the aggregate's own guard.
 *
 * ## No LLM call, no policy re-evaluation
 *
 * Unlike `SubmitIntent`/`AnswerClarification`, this use-case never calls an
 * `LlmClient` and never runs `applyPolicy` — there is no proposal to reason
 * about and no verdict to compute. This is also why it takes no `LlmClient`
 * or `PolicyConfig` constructor parameter: an injected-but-unused port would
 * be a false dependency. `SubmitIntent.execute`'s header raises staleness as
 * a reason a persisted "allow" verdict would be wrong by the time a future
 * use-case claims and executes an intent — that argument is time-dependence
 * of a decision that later moves money. It doesn't apply here: rejecting
 * moves no money, and the intent that gets rejected never executes, so
 * there's no later point where a stale verdict could matter.
 *
 * ## Why there is no rejection-reason field on this command
 *
 * Spec §7's `POST /intents/:id/reject` has an empty request body, unlike
 * `/clarify`'s `{ answer }` — there is nothing for a caller to supply beyond
 * the id. And a human rejection is already uniquely distinguishable from
 * the other three routes into `rejected` from the persisted row alone (see
 * `domain/intent.ts`'s class header for the full four-route table): on a
 * `rejected` row, `policyVerdict?.decision === "needs_approval"` uniquely
 * means a human rejected it via `rejectByApprover`, because `requireApproval`
 * is the only transition that ever writes that decision, and
 * `rejectByApprover` never clears it. No new field is needed to tell this
 * route apart from the other three.
 *
 * ## Exactly one repository write
 *
 * This method calls `this.repo.update(intent, stored.version)` exactly
 * once. It never calls `this.repo.create()` — the intent already exists.
 *
 * ## No retry on `IntentVersionConflictError` — and this write must NEVER
 * become unconditional
 *
 * A version conflict from that single `update()` call propagates uncaught;
 * there is no retry loop. This is the single most important invariant in
 * this file: the conditional `update(intent, expectedVersion)` call — i.e.
 * the equivalent of `UPDATE ... WHERE id = $1 AND version = $2` — is the
 * ENTIRE mechanism preventing a reject from clobbering a row that a
 * concurrent (future) `ApproveIntent` has already claimed into `executing`.
 * Do NOT "simplify" this write into an unconditional
 * `UPDATE ... SET status = 'rejected'`, and do NOT retry a version conflict
 * by re-reading and forcing the write through — either change would let a
 * reject land on top of an already-executing workflow, meaning money moved
 * but the persisted record claims otherwise. If `update()` throws here, the
 * correct behaviour is exactly what already happens: let it propagate.
 *
 * ## Return shape: a bare `IntentView`, not `{ intent, verdict }`
 *
 * `SubmitIntent`/`AnswerClarification` return `{ intent, verdict }` because
 * policy may or may not have just run, and an `allow` verdict is
 * deliberately not persisted — the caller needs the ephemeral verdict
 * alongside the stored view. Here that shape would be actively misleading:
 * this use-case never computes a verdict, so a `verdict` field would always
 * read `null`, even though `intent.policyVerdict` on the returned view is
 * NOT null — it's the `needs_approval` verdict that created the approval
 * gate in the first place. Returning a bare `IntentView` (matching
 * `GetIntent`'s return shape) avoids that false signal.
 *
 * ## No caller/customer scoping (yet)
 *
 * `RejectIntentCommand` carries no caller identity — anyone who knows an
 * intent id can reject it, terminating someone else's pending payment.
 * This is a state-CHANGING operation, so the gap matters more here than on
 * `GetIntent`'s read path. Ownership scoping against `Intent.customerId`
 * is deferred to the future HTTP/auth layer (step 8) and MUST be enforced
 * there before this is exposed as `POST /intents/:id/reject` — this
 * use-case alone cannot and does not check it.
 */
export class RejectIntent {
  constructor(
    private readonly repo: IntentRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(raw: RejectIntentCommand): Promise<IntentView> {
    const command = RejectIntentCommand.parse(raw);
    const now = this.clock();
    const stored = await this.repo.findById(command.intentId);
    if (!stored) {
      throw new IntentNotFoundError(command.intentId);
    }
    // The aggregate's own status guard IS the wrong-status check — no
    // separate check needed here.
    stored.intent.rejectByApprover(now);
    const updated = await this.repo.update(stored.intent, stored.version);
    return toIntentView(updated.intent);
  }
}
