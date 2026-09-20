import { z } from "zod";
import {
  IntentNotFoundError,
  InvalidIntentStateError,
  InvalidProposalError,
} from "../domain/errors.js";
import { CUSTOMER_ID_PATTERN } from "../domain/intent.js";
import type { AgentCoreClient } from "../ports/agent-core-client.js";
import { paymentWorkflowRequestFor } from "../ports/agent-core-client.js";
import {
  IntentVersionConflictError,
  type IntentRepository,
} from "../ports/intent-repository.js";
import type { PolicyConfig } from "../policy/rules.js";
import { resolvePolicyConfig } from "../policy/rules.js";
import type { PolicyVerdict } from "../policy/verdict.js";
import { applyPolicy } from "./apply-policy.js";
import { ExecutionRaceLostError } from "./approve-intent.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const AutoApproveIntentCommand = z.object({
  intentId: z.string().min(1),
  /**
   * The caller's own customerId, checked against the stored `Intent
   * .customerId` before anything else runs — see class header, "Caller/
   * customer scoping". Same shape `SubmitIntentCommand.shape.customerId`
   * validates with (ADR-0014's `CustomerIdHeader` pattern).
   */
  customerId: z.string().regex(CUSTOMER_ID_PATTERN),
});
export type AutoApproveIntentCommand = z.infer<typeof AutoApproveIntentCommand>;

export interface AutoApproveIntentResult {
  readonly intent: IntentView;
  /**
   * The FRESH verdict this call's own re-evaluation produced — never
   * `SubmitIntent`'s original verdict, which may be stale by the time this
   * runs (see "Why policy is re-evaluated" below). `null` only on the
   * `executing` short-circuit, where no re-evaluation happens at all because
   * an earlier call already consumed one.
   */
  readonly verdict: PolicyVerdict | null;
}

/**
 * Give `Intent.autoApprove` (`domain/intent.ts`) its first production
 * caller: a `proposed` intent whose ORIGINAL policy verdict (computed inside
 * `SubmitIntent`/`AnswerClarification`, see `apply-policy.ts`'s header for
 * why that verdict is never persisted) was `allow`, re-evaluated and, if
 * still `allow`, triggered against `durable-ledger`. This is the SECOND (and
 * last) use-case in this package that ever calls
 * `AgentCoreClient.startPaymentWorkflow` — `ApproveIntent`
 * (`app/approve-intent.ts`) is the other, and this file mirrors its
 * money-safety shape closely: the `executing` short-circuit, the
 * before/after `execute()` guard ordering, the two-clock-reads split, the
 * `ExecutionRaceLostError` handling on a lost write race (imported from
 * `approve-intent.ts`, not redefined — see that class's own header for the
 * full rationale, which applies unchanged here).
 *
 * ## Reachable outcomes
 *
 * Four: `executing` (a fresh `allow` re-evaluation triggers durable-ledger,
 * or a short-circuited replay of an intent already `executing`),
 * `needs_approval` (the fresh re-evaluation gates it — the original
 * submission's `allow` was stale), or `rejected` (the fresh re-evaluation
 * hard-rejects it). Every other status throws `InvalidIntentStateError`.
 *
 * ## Why policy is re-evaluated here, not reused from `SubmitIntent`
 *
 * `apply-policy.ts`'s own header already explains why an `allow` verdict is
 * never persisted: `dailyRateLimit` is time-dependent, and more of the
 * customer's intents may have completed between submission and whenever this
 * use-case actually runs. Trusting `SubmitIntent`'s original `allow` here
 * would money-move against a verdict that may no longer hold. `applyPolicy`
 * is called again, with a real `now`, exactly as `SubmitIntent` and
 * `AnswerClarification` already do — this is that helper's third caller.
 *
 * ## Why the status guard runs before the external call — the single most
 * dangerous possible simplification, same as `ApproveIntent`'s own warning
 *
 * `Intent.autoApprove`'s own internal guard (`assertStatus(["proposed"], ...)`)
 * only runs AFTER `AgentCoreClient.startPaymentWorkflow` in this method's
 * sequence (step 10, well below the trigger call in step 8). Relying on it
 * alone — deleting the explicit `stored.intent.status` checks below — would
 * still compile and still pass a happy-path test, while silently
 * reintroducing the ability to trigger a REAL payment against an already
 * `rejected`/`completed`/`needs_approval` intent before the guard ever
 * fires. The explicit `executing` short-circuit, then the `proposed` guard,
 * are what prevent that, and they MUST run before any client call, not
 * after.
 *
 * ## Why `executing` short-circuits instead of throwing
 *
 * Mirrors spec §6/§10's requirement on `ApproveIntent`: a re-invocation on an
 * already-`executing` intent (a concurrent retry that already won this same
 * race) makes NO client call and returns the already-stored view, not a
 * 422. The only writer that could ever race a `proposed` row into
 * `executing` here is another concurrent `AutoApproveIntent` call on the
 * SAME intent — `reject`/`clarify`/sync-execution all require the intent to
 * already be in some OTHER status first — so a version conflict on this
 * method's own write specifically means "another auto-approve call already
 * won", not some unrelated transition.
 *
 * ## Why `this.clock()` is read twice, not once
 *
 * The first read (step 6, before `applyPolicy`) is the policy re-evaluation
 * instant: it defines the `dailyRateLimit` window AND is the timestamp
 * stamped onto a `needs_approval`/`reject` write, exactly like
 * `SubmitIntent`/`AnswerClarification`'s own single early read — one instant
 * has to cover several domain operations performed conceptually together.
 * The second read happens strictly AFTER `startPaymentWorkflow` resolves,
 * for exactly the reason `approve-intent.ts`'s own header gives: `updatedAt`
 * on the `executing` transition is supposed to record the moment the intent
 * actually entered `executing`, and that external call is the one step here
 * that can legitimately take seconds or time out and retry, entirely outside
 * this process's control. Reading the clock before making it would stamp
 * `updatedAt` with a time that PRECEDES the very event it records. The two
 * reads serve different purposes and must never be conflated into one.
 *
 * ## Exactly one repository write
 *
 * Either the `needs_approval`/`reject` write inside the fresh-verdict branch
 * (step 7), or the `autoApprove` confirming write (step 10) — never both,
 * and the `executing` short-circuit (step 3) writes nothing at all. On
 * `allow`, `applyPolicy` deliberately does NOT mutate/persist anything (see
 * its own header) — this method's own `autoApprove` call is the only write
 * on that path.
 *
 * ## No retry on a version conflict
 *
 * Same policy as `ApproveIntent`: a bare `IntentVersionConflictError` from
 * the confirming write would discard the only handle to a live,
 * money-moving workflow this method just triggered. `execute()` catches
 * exactly that and rethrows `ExecutionRaceLostError` (imported, not
 * redefined) carrying the orphaned `eventId` forward — the caller must
 * reconcile it, not retry.
 *
 * ## Caller/customer scoping — defense in depth, not structurally required
 *
 * Unlike `ApproveIntent`, `AnswerClarification`, `RejectIntent`, and
 * `GetIntent` (whose own headers document deliberately NOT scoping by
 * caller/customer, deferring entirely to the HTTP layer's own pre-check per
 * ADR-0014), this use-case DOES compare `command.customerId` against the
 * stored `Intent.customerId` itself (step 2, before anything else runs),
 * throwing the exact same `IntentNotFoundError` a genuine miss would throw
 * on a mismatch — never a 403, same "why 404, not 403" reasoning ADR-0014
 * gives for the HTTP layer's own checks. At this use-case's one and only
 * call site (`app.ts`'s `POST /intents` handler, immediately after a keyed
 * `SubmitIntent` call), the `intentId` passed in is always already scoped to
 * the SAME caller's own `customerId` — either freshly minted for this
 * request or derived via `deriveIntentId(customerId, idempotencyKey)` from
 * it (ADR-0015) — so this check can never actually fire today. It exists
 * anyway as a mechanical safety net: nothing about `AutoApproveIntentCommand`
 * itself previously stopped a future second call site from skipping the
 * ownership argument this file's callers are trusted to uphold. Requiring
 * `customerId` on the command and checking it here, in this file, makes that
 * regression impossible to reintroduce silently — a future caller would have
 * to explicitly pass the WRONG customerId to defeat it, not just omit a
 * step someone else was supposed to remember.
 */
export class AutoApproveIntent {
  private readonly policyConfig: PolicyConfig;

  constructor(
    private readonly repo: IntentRepository,
    private readonly agentCore: AgentCoreClient,
    private readonly paymentMethodToken: string,
    policyConfig: Partial<PolicyConfig> = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    // Fail fast on a blank token at construction time, not on the first request.
    if (paymentMethodToken.trim() === "") {
      throw new Error(
        "AutoApproveIntent: paymentMethodToken must not be blank",
      );
    }
    this.policyConfig = resolvePolicyConfig(policyConfig);
  }

  async execute(
    raw: AutoApproveIntentCommand,
  ): Promise<AutoApproveIntentResult> {
    const command = AutoApproveIntentCommand.parse(raw);
    const stored = await this.repo.findById(command.intentId);
    // Ownership check — see class header, "Caller/customer scoping". Same
    // IntentNotFoundError shape on a mismatch as on a genuine miss, so a
    // caller can never distinguish "no such intent" from "not yours".
    if (!stored || stored.intent.customerId !== command.customerId) {
      throw new IntentNotFoundError(command.intentId);
    }
    const intent = stored.intent;

    // §6/§10-style replay short-circuit: MUST run before any client call.
    // See class header, "Why the status guard runs before the external
    // call" — relying on Intent.autoApprove's own guard instead would be
    // actively dangerous, not just inefficient, because that guard only
    // fires AFTER the external call below.
    if (intent.status === "executing") {
      return { intent: toIntentView(intent), verdict: null };
    }
    if (intent.status !== "proposed") {
      throw new InvalidIntentStateError(intent.status, "autoApprove");
    }

    const proposal = intent.paymentProposal;
    if (proposal === null) {
      throw new InvalidProposalError(
        `Intent "${intent.id}" is proposed but its proposal is not a payment proposal`,
      );
    }

    // Read once, before the (real, fresh) policy re-evaluation — this
    // instant defines the dailyRateLimit window and, if the verdict gates
    // or rejects, is also the timestamp stamped onto that write. See class
    // header, "Why this.clock() is read twice".
    const now = this.clock();
    const verdict = await applyPolicy(
      intent,
      proposal,
      { repo: this.repo, config: this.policyConfig },
      now,
    );

    if (verdict.decision !== "allow") {
      // applyPolicy already mutated `intent` in place (requireApproval /
      // rejectByPolicy) — see apply-policy.ts's header. Do NOT call
      // durable-ledger on this path.
      const updated = await this.repo.update(intent, stored.version);
      return { intent: toIntentView(updated.intent), verdict };
    }

    const request = paymentWorkflowRequestFor({
      proposal,
      paymentMethodToken: this.paymentMethodToken,
    });
    const { eventId } = await this.agentCore.startPaymentWorkflow(request, {
      idempotencyKey: intent.id,
    });

    // Read deliberately AFTER the external call, not reused from above —
    // see class header, "Why this.clock() is read twice": updatedAt must
    // record when the intent actually entered `executing`, and this call is
    // the one step that can take a variable, unbounded amount of time.
    const executedAt = this.clock();
    intent.autoApprove({ verdict, durableLedgerEventId: eventId }, executedAt);

    try {
      const updated = await this.repo.update(intent, stored.version);
      return { intent: toIntentView(updated.intent), verdict };
    } catch (err) {
      if (err instanceof IntentVersionConflictError) {
        throw new ExecutionRaceLostError(intent.id, eventId, { cause: err });
      }
      throw err;
    }
  }
}
