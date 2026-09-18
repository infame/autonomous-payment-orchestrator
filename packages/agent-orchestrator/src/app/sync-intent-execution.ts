import { z } from "zod";
import { IntentNotFoundError } from "../domain/errors.js";
import {
  AgentCoreClientError,
  type AgentCoreClient,
} from "../ports/agent-core-client.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const SyncIntentExecutionCommand = z.object({
  intentId: z.string().min(1),
});
export type SyncIntentExecutionCommand = z.infer<
  typeof SyncIntentExecutionCommand
>;

/**
 * Reconciles an `executing` intent against durable-ledger's actual workflow
 * status, closing the gap left by `ApproveIntent`: nothing else in this
 * package ever calls `AgentCoreClient.getRunStatus`, and `Intent.complete`/
 * `Intent.fail`/`Intent.flagForReview` otherwise have no caller at all — an
 * intent that reaches `executing` would stay `executing` forever.
 *
 * ## Reachable outcomes
 *
 * Four outcomes are possible per call: `completed`, `failed`, `needs_review`
 * (all three via one conditional repository write), or unchanged — either
 * because the intent wasn't `executing` to begin with (its status, whatever
 * it already was, is returned as-is), or because it IS `executing` but
 * durable-ledger's snapshot isn't terminal yet (`queued`/`running`), or
 * because the durable-ledger call itself failed. See below for the latter
 * two.
 *
 * ## Why this is a separate use-case, not an optional dependency on `GetIntent`
 *
 * Giving `GetIntent` an optional `agentCore` constructor parameter would
 * make an optional argument silently turn a pure query into a mutating
 * call — a caller who forgets to pass it gets silently-stale reads, and a
 * caller who does pass it gets a `GetIntent` that sometimes writes, which
 * `GetIntent`'s own name and every existing caller's expectations
 * contradict. `GetIntent` stays the pure primitive; this is the reconciling
 * variant a future HTTP `GET /intents/:id` route will call instead. This
 * does create mild redundancy — two use-cases that both read an intent by
 * id and return an `IntentView` — accepted deliberately as the cost of
 * keeping "pure query" and "reconcile against an external system" from
 * living in the same method behind a flag.
 *
 * ## Why an `AgentCoreClientError` is swallowed here, unlike `ApproveIntent`
 *
 * This is the *read* path a polling client (the future `GET /intents/:id`
 * route) hammers repeatedly. If durable-ledger is unavailable, the last
 * known state — `executing` — is still a valid, useful answer: the intent
 * really was executing as of the last successful sync, and a stale
 * `executing` is a strictly better response on this path than surfacing a
 * 503 on every single poll. This is the opposite tradeoff from
 * `ApproveIntent`, where the very call that fails is the one that was
 * SUPPOSED to move money — if it fails there, the caller's requested action
 * genuinely did not happen, so the error must propagate. Nothing here is
 * requesting an action; it's asking "did anything change", and "no new
 * information" is itself a legitimate answer.
 *
 * ## `durableLedgerEventId === null` while `status === "executing"`
 *
 * Structurally unreachable in practice: `domain/intent.ts`'s header
 * documents that `Intent.approve`/`Intent.autoApprove` write
 * `durableLedgerEventId` in the very same mutation that flips `status` to
 * `executing`, and the Postgres schema's `intents_executing_requires_event_id`
 * CHECK constraint enforces the same rule at the storage boundary. The
 * `null` check here is defensive only — if it were somehow false, returning
 * the stored view unchanged (rather than throwing, or calling
 * `agentCore.getRunStatus` with a value it cannot accept) is the safest
 * available response.
 *
 * ## Exactly one repository write
 *
 * `this.repo.update(intent, stored.version)` is called at most once per
 * `execute()` invocation, and only when an actual transition happened
 * (`completed`/`failed`/`needs_review`). Every other path — not `executing`
 * to begin with, no `durableLedgerEventId`, an `AgentCoreClientError`, or a
 * non-terminal (`queued`/`running`) snapshot — returns without writing.
 *
 * ## `needsReview` is checked before `status`
 *
 * `WorkflowRunSnapshot.needsReview` (`ports/agent-core-client.ts`) is checked
 * FIRST, before branching on `status` at all. This is defense-in-depth, not
 * a response to real orthogonality: durable-ledger's actual producer
 * (`inngest-workflow-runs.ts`, mirrored in `agent-core-client.ts`'s own doc
 * comment on the field) computes `needsReview` as `status === "failed" AND
 * output contains NEEDS_REVIEW_MARKER` — so in practice `needsReview: true`
 * only ever shows up together with `status === "failed"`, never alongside
 * `completed`/`queued`/`running`/`cancelled`. Checking it first still
 * matters: it's what makes a flagged-for-review failure land on
 * `needs_review` rather than silently falling into the `failed` branch
 * below, and it means a future change to either side of this port boundary
 * that weakens the invariant fails safe (toward `needs_review`, the more
 * conservative outcome) rather than silently reordering itself into
 * `failed`.
 *
 * ## No retry on a version conflict
 *
 * A version conflict from the single `update()` call propagates uncaught,
 * same house rule as `RejectIntent`/`ApproveIntent`. Unlike `ApproveIntent`,
 * there is no `ExecutionRaceLostError` concern here: this use-case never
 * triggers anything external, it only records the result of a read that
 * already happened — a retry would just re-read the intent and find it
 * already moved to its terminal state by whoever won the race, converting
 * one signal (the snapshot this call just fetched) into another (the
 * winner's own write) for no benefit. Letting the conflict propagate is
 * correct as-is. The future HTTP layer that calls this use-case (step 8)
 * still needs to decide what to do with a bare `IntentVersionConflictError`
 * surfacing here — the simplest correct handling is to re-read the intent
 * (the winner's write already recorded the true state) and return that,
 * rather than mapping it to a client-visible error status; this file does
 * not make that call itself.
 *
 * ## Return shape
 *
 * A bare `IntentView`, matching `RejectIntent`/`GetIntent`/`ApproveIntent` —
 * no verdict is computed here.
 *
 * ## No caller/customer scoping (yet)
 *
 * `SyncIntentExecutionCommand` carries no caller identity. Unlike the
 * earlier use-cases' vaguer "deferred to the future HTTP/auth layer"
 * wording, the mechanism here is already decided, just not yet built: a
 * later slice of this same spec step (step 8) will enforce ownership at the
 * HTTP boundary by comparing a customer-identity header against
 * `Intent.customerId` before this use-case is ever reachable as
 * `GET /intents/:id`. This use-case alone cannot and does not check it.
 */
export class SyncIntentExecution {
  constructor(
    private readonly repo: IntentRepository,
    private readonly agentCore: AgentCoreClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(raw: SyncIntentExecutionCommand): Promise<IntentView> {
    const command = SyncIntentExecutionCommand.parse(raw);
    const stored = await this.repo.findById(command.intentId);
    if (!stored) {
      throw new IntentNotFoundError(command.intentId);
    }
    const intent = stored.intent;

    if (intent.status !== "executing") {
      // Nothing to sync — no client call, no write.
      return toIntentView(intent);
    }
    if (intent.durableLedgerEventId === null) {
      // Defensive/unreachable — see class header. Never a real state for an
      // `executing` intent.
      return toIntentView(intent);
    }

    let snapshot;
    try {
      snapshot = await this.agentCore.getRunStatus(intent.durableLedgerEventId);
    } catch (err) {
      if (err instanceof AgentCoreClientError) {
        // Swallowed deliberately — see class header. A stale "executing" is
        // a strictly better answer on this read path than a 503; it IS the
        // intent's last known true state.
        return toIntentView(intent);
      }
      throw err;
    }

    const now = this.clock();
    // Checked FIRST, before `status` — see class header, "`needsReview` is
    // checked before `status`".
    if (snapshot.needsReview) {
      intent.flagForReview(now);
    } else if (snapshot.status === "completed") {
      intent.complete(now);
    } else if (
      snapshot.status === "failed" ||
      snapshot.status === "cancelled"
    ) {
      // snapshot.failureMessage is deliberately dropped here, not copied
      // onto Intent — same reasoning as domain/intent.ts's header on why
      // there is no failureReason/rejectionReason field: the cause of a
      // failed/needs_review intent lives in durable-ledger/Inngest,
      // reachable via durableLedgerEventId, and a local copy would just be
      // a stale duplicate of another system's truth.
      intent.fail(now);
    } else {
      // queued | running — no transition yet, no write.
      return toIntentView(intent);
    }

    const updated = await this.repo.update(intent, stored.version);
    return toIntentView(updated.intent);
  }
}
