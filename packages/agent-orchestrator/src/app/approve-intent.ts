import { z } from "zod";
import {
  IntentNotFoundError,
  InvalidIntentStateError,
  InvalidProposalError,
  OrchestratorError,
} from "../domain/errors.js";
import type { AgentCoreClient } from "../ports/agent-core-client.js";
import { paymentWorkflowRequestFor } from "../ports/agent-core-client.js";
import {
  IntentVersionConflictError,
  type IntentRepository,
} from "../ports/intent-repository.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const ApproveIntentCommand = z.object({
  intentId: z.string().min(1),
});
export type ApproveIntentCommand = z.infer<typeof ApproveIntentCommand>;

/**
 * A durable-ledger workflow was triggered for this intent, but the write
 * that would have recorded it lost an optimistic-lock race (a concurrent
 * `RejectIntent`, or a second `ApproveIntent`, wrote first). Carries the
 * orphaned `durableLedgerEventId` because it is the ONLY handle to a live,
 * money-moving run — nothing can resolve it from the idempotency key alone
 * (ADR-0010/ADR-0013 in `@apo/durable-ledger`: there is deliberately no
 * `workflow_runs` correlation table to look it up by). Never retried here:
 * a re-read would find the intent already `executing` (someone else's
 * approve won) or `rejected` (a reject won), and blindly retrying would
 * only convert this into a bare `InvalidIntentStateError` — discarding the
 * one piece of information (the eventId) that made this case worth
 * distinguishing from an ordinary version conflict. Needs operator
 * reconciliation, not a retry loop.
 */
export class ExecutionRaceLostError extends OrchestratorError {
  readonly code = "execution_race_lost";
  constructor(
    readonly intentId: string,
    readonly durableLedgerEventId: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Intent "${intentId}" lost a concurrent write race after durable-ledger accepted workflow "${durableLedgerEventId}" — that run is now unreferenced by this intent and needs reconciliation`,
    );
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Explicitly approve an intent sitting at a human approval gate, triggering
 * the actual durable-ledger payment workflow. This is the ONLY use-case in
 * this package that ever calls `AgentCoreClient.startPaymentWorkflow` — the
 * operation that moves real money.
 *
 * ## Reachable outcomes
 *
 * Exactly one status is reachable through this use-case: `executing`.
 * There are two ways to arrive there: a newly-triggered approval
 * (`needs_approval → executing`, a fresh durable-ledger call), or a
 * short-circuited replay of an intent that was already `executing` when
 * `execute()` was called — which makes NO client call at all and simply
 * returns the already-stored view. See the next two sections for why both
 * shapes exist and why they must stay in that order.
 *
 * ## Why the external call comes before the only write
 *
 * A "claim" write — provisionally marking the intent as claimed BEFORE
 * calling durable-ledger, then calling out — is structurally impossible on
 * this port. `Intent.approve` requires a real `durableLedgerEventId` as an
 * argument before it will allow the transition to `executing`, and the
 * Postgres schema's `intents_executing_requires_event_id` CHECK enforces
 * the same rule at the storage boundary. Only durable-ledger can mint that
 * id. So the order is forced: call `AgentCoreClient.startPaymentWorkflow`
 * first, and only then call `this.repo.update()` — once — with the real id
 * in hand.
 *
 * That ordering, combined with ADR-0013's caller-supplied
 * `idempotencyKey` (this method passes `intent.id`), closes the MONEY half
 * of spec §6's exactly-once requirement — no matter how many times this
 * method is called (or retried, or raced) for the same intent, Inngest
 * creates AT MOST ONE real `payment.execute` run — but only WITHIN
 * Inngest's own event-retention window. That qualifier is ADR-0013's own,
 * not hedging added here: its Consequences section states plainly that the
 * guarantee is "bounded... not an absolute one," and that the window itself
 * was verified only against a local dev server, never measured against
 * Inngest Cloud. What this ordering does NOT close, window or no window, is
 * a residual "handle" problem: if this process crashes in the
 * narrow window between durable-ledger accepting the call and this
 * method's own `update()` landing, a LATER retry sends the same
 * `idempotencyKey` again, gets back a DIFFERENT `eventId` — one that is a
 * permanent dud, since Inngest already attached the one real run to the
 * FIRST event — and THAT dud eventId is what ends up persisted, not the
 * real one. This is ACCEPTED, not further solved here: no reconciliation
 * table, no polling-harder fix. A stuck `queued` status on the persisted
 * `durableLedgerEventId` is the visible symptom and the reconciliation
 * signal an operator would need to act on, not a bug in this method.
 *
 * ## Why `executing` short-circuits instead of throwing
 *
 * Spec §6/§10 explicitly require a re-invocation on an already-`executing`
 * intent to make NO client call and return the ALREADY-stored eventId, not
 * a 422 — a deliberate divergence from how every OTHER wrong-status case
 * in this method (and every other use-case in this package) behaves.
 *
 * ## Why the status guard runs before the external call, unlike `RejectIntent`
 *
 * `RejectIntent`'s own header correctly says its aggregate's own guard IS
 * the wrong-status check, with no separate check needed — that's safe
 * there because `rejectByApprover` has no side effect in front of it.
 * Relying on `Intent.approve`'s internal guard alone would be actively
 * DANGEROUS here, not just a missed optimization: that guard only runs
 * AFTER the `AgentCoreClient.startPaymentWorkflow` call in this method's
 * sequence, so approving an already-`rejected` or `completed` intent would
 * trigger a REAL payment and only THEN throw. The explicit `intent.status`
 * checks below — the `executing` short-circuit, then the `needs_approval`
 * guard — are what prevent that. This is the single most dangerous
 * possible "simplification" of this file: deleting either check to rely on
 * `Intent.approve`'s own guard would still compile and would still pass a
 * happy-path test, while silently reintroducing the ability to pay against
 * a rejected or already-completed intent.
 *
 * ## Why `this.clock()` is read AFTER the external call, unlike every other use-case
 *
 * `execute()` reads `now` only once `AgentCoreClient.startPaymentWorkflow`
 * has already resolved, not at the top of the method the way
 * `SubmitIntent`/`AnswerClarification`/`RejectIntent` all do. `updatedAt` is
 * supposed to record the moment this intent actually entered `executing` —
 * and that call is the one step in this whole method that can legitimately
 * take seconds, or time out and retry, entirely outside this process's
 * control. Reading the clock before making it would stamp `updatedAt` with
 * a time that PRECEDES the very event it's supposed to be recording,
 * understating how long the intent actually sat at `needs_approval`.
 * `SubmitIntent`/`AnswerClarification` also make an unbounded call (to
 * `LlmClient`) before their one write, and still read the clock up front —
 * but that single `now` has to be stamped across several domain
 * transitions plus a policy evaluation performed on the SAME conceptual
 * instant, so one early read is correct there. This method has exactly one
 * transition, and it happens after the one unbounded call — there's
 * nothing else `now` needs to agree with, so reading it after is what
 * makes `updatedAt` honest instead of just consistent.
 *
 * ## No policy re-evaluation
 *
 * `approve()` computes no verdict. Overwriting `intent.policyVerdict` here
 * would destroy the four-route rejection-cause discriminator table already
 * established in `domain/intent.ts`'s header — and there is no legal
 * domain transition from `needs_approval` to a fresh `reject`/`needs_approval`
 * verdict anyway; the only two transitions out of `needs_approval` are
 * `approve` and `rejectByApprover`.
 *
 * ## Exactly one repository write
 *
 * The conditional `this.repo.update(intent, stored.version)` call — never
 * called more than once per `execute()` invocation, and never made
 * unconditional. Matching `RejectIntent`'s established warning: that
 * conditional check is the ENTIRE mechanism preventing an approve and a
 * reject from clobbering each other. Do not "simplify" it into an
 * unconditional write.
 *
 * ## No retry on a version conflict, and why it becomes `ExecutionRaceLostError`
 *
 * A bare `IntentVersionConflictError` from that write would discard the
 * only handle to a live, money-moving workflow that this method just
 * triggered — the caller would have no way to find that `eventId` again.
 * `execute()` catches exactly that error and rethrows `ExecutionRaceLostError`
 * (this file, above), which carries the orphaned `eventId` forward instead
 * of losing it. No retry is attempted: a retry would just re-read the
 * intent, find it no longer `needs_approval`, and either short-circuit
 * (if the winner was itself an approve) or throw `InvalidIntentStateError`
 * (if the winner was a reject) — neither path needs this method to try
 * again, and forcing the write through unconditionally is exactly the
 * clobbering `RejectIntent`'s header already warns against, from this
 * side of the race.
 *
 * ## Return shape
 *
 * A bare `IntentView`, matching `RejectIntent`/`GetIntent` — never
 * `{ intent, verdict }`. No verdict is computed here, and the view
 * legitimately still carries the original `needs_approval` verdict that
 * opened the approval gate in the first place; a `verdict` field on the
 * result would always read `null` and falsely suggest nothing had been
 * decided. The returned view carries `durableLedgerEventId` (the whole
 * point of this use-case) but NEVER `paymentMethodToken` — that value
 * never touches `IntentView` at all, only the wire request built by
 * `paymentWorkflowRequestFor`.
 *
 * ## No caller/customer scoping (yet) — worded more forcefully than the siblings
 *
 * `ApproveIntentCommand` carries no caller identity. This is the operation
 * that actually moves money: anyone who knows an intent id can call this
 * method and trigger a real payment against someone else's intent. This
 * is not a hypothetical gap to note in passing — it MUST be closed at the
 * future HTTP/auth layer (step 8) before this use-case is ever wired up as
 * `POST /intents/:id/approve`. Ownership scoping against `Intent.customerId`
 * belongs there, not here; this use-case alone cannot and does not check it.
 *
 * ## A forward-looking note on the idempotency key
 *
 * `intent.id` is used as the durable-ledger `idempotencyKey` (see "Why the
 * external call comes before the only write" above). That choice means any
 * FUTURE payment-retry feature — e.g. "retry this failed payment" as a new
 * transition on an already-`executing`/`failed` intent — must NOT reuse
 * `intent.id` as its key, or Inngest will silently discard the retry
 * attempt as a duplicate, with no error at all (ADR-0013 does no conflict
 * detection). This is safe today because there is no such retry transition
 * on `Intent`, but must be revisited the moment one is added.
 */
export class ApproveIntent {
  constructor(
    private readonly repo: IntentRepository,
    private readonly agentCore: AgentCoreClient,
    private readonly paymentMethodToken: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    // Fail fast on a blank token at construction time, not on the first request.
    if (paymentMethodToken.trim() === "") {
      throw new Error("ApproveIntent: paymentMethodToken must not be blank");
    }
  }

  async execute(raw: ApproveIntentCommand): Promise<IntentView> {
    const command = ApproveIntentCommand.parse(raw);
    const stored = await this.repo.findById(command.intentId);
    if (!stored) {
      throw new IntentNotFoundError(command.intentId);
    }
    const intent = stored.intent;

    // §6/§10 replay short-circuit: MUST run before any client call. See
    // class header, "Why the status guard runs before the external call" —
    // relying on Intent.approve's own guard instead would be actively
    // dangerous, not just inefficient, because that guard only fires AFTER
    // the external call below.
    if (intent.status === "executing") {
      return toIntentView(intent);
    }
    if (intent.status !== "needs_approval") {
      throw new InvalidIntentStateError(intent.status, "approve");
    }

    const proposal = intent.paymentProposal;
    if (proposal === null) {
      throw new InvalidProposalError(
        `Intent "${intent.id}" is needs_approval but its proposal is not a payment proposal`,
      );
    }

    const request = paymentWorkflowRequestFor({
      proposal,
      paymentMethodToken: this.paymentMethodToken,
    });
    const { eventId } = await this.agentCore.startPaymentWorkflow(request, {
      idempotencyKey: intent.id,
    });

    // Read deliberately AFTER the external call, not at the top of
    // execute() — see class header, "Why this.clock() is read AFTER the
    // external call": updatedAt must record when the intent actually
    // entered `executing`, and this call is the one step that can take a
    // variable, unbounded amount of time.
    const now = this.clock();
    intent.approve(eventId, now);

    let updated;
    try {
      updated = await this.repo.update(intent, stored.version);
    } catch (err) {
      if (err instanceof IntentVersionConflictError) {
        throw new ExecutionRaceLostError(intent.id, eventId, { cause: err });
      }
      throw err;
    }
    return toIntentView(updated.intent);
  }
}
