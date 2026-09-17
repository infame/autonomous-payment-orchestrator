import type { PaymentExecuteRequested } from "../workflow/events.js";

/**
 * Driving port for starting and observing `payment.execute` runs, independent
 * of talking to Inngest directly. Mirrors this package's `PayCoreClient` port
 * in spirit: the HTTP layer (`../adapters/http/app.js`) depends only on this
 * interface, never on `Inngest` itself.
 *
 * There is deliberately no `workflow_runs` table — run status is read live
 * from Inngest's own REST API (`InngestWorkflowRuns`,
 * `../adapters/inngest/inngest-workflow-runs.js`) rather than mirrored into
 * this package's own Postgres schema. Two independent claims that used to be
 * one ("there is no way to supply your own correlation key") now have to be
 * kept apart:
 *
 * - **Dedupe is now possible.** `startPaymentExecute`'s optional
 *   `StartPaymentExecuteOptions.idempotencyKey` lets a caller prevent a
 *   retried/duplicated trigger from starting a second, independent run —
 *   introduced by [ADR-0013](../../docs/adr/0013-optional-trigger-idempotency-key.md).
 * - **Lookup by that key is still impossible.** The server-assigned
 *   `eventId` remains the only handle `findByEventId` accepts; nothing
 *   resolves a run from a caller-chosen key (ADR-0010's limitation stands,
 *   narrowed by ADR-0013 to "unless a lookup handle is what's actually
 *   needed", which dedup alone does not require).
 *
 * A consequence of dedupe worth stating bluntly: on a deduplicated trigger,
 * the `eventId` returned to the caller is a fresh event that will never have
 * a run — `findByEventId` will report `queued` for it indefinitely. This is
 * not a bug; it's the accepted "dud handle" outcome documented in ADR-0013.
 */
export type WorkflowRunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRunSnapshot {
  readonly eventId: string;
  /** `null` while `status === "queued"` — Inngest hasn't matched a run to the event yet. */
  readonly runId: string | null;
  readonly status: WorkflowRunStatus;
  /** ISO-8601, or `null` before the run has started. */
  readonly startedAt: string | null;
  /** ISO-8601, or `null` while the run is still in flight. */
  readonly endedAt: string | null;
  /** `true` iff `status === "failed"` AND the run's output contains `NEEDS_REVIEW_MARKER`. */
  readonly needsReview: boolean;
  readonly failureMessage: string | null;
}

export interface StartPaymentExecuteOptions {
  /**
   * Caller-supplied de-duplication key. Forwarded to the workflow engine as
   * its event-level idempotency id — namespaced by `data.merchantId`
   * (`InngestWorkflowRuns`) so two unrelated callers who happen to pick the
   * same "natural" key (`order-1`, a shared counter, ...) for two DIFFERENT
   * merchants don't collide with each other; see ADR-0013's Consequences for
   * the residual same-merchant collision risk this does not solve. Within
   * that namespace, a second trigger carrying the same key (within the
   * engine's retention window) starts NO second run.
   *
   * Two things this is NOT:
   *  - NOT a lookup handle. Nothing can resolve a run from this key; the
   *    `eventId` below remains the only handle (ADR-0010, ADR-0013).
   *  - NOT pay-core's `Idempotency-Key`: no stored result is replayed and a
   *    same-key/different-body retry is discarded, not rejected with 409.
   *
   * Must never be derived from `paymentMethodToken` or any other credential
   * — the value is stored by, and visible in, the workflow engine.
   *
   * **Shape is validated by the adapter itself, not just by the HTTP
   * layer.** `InngestWorkflowRuns.startPaymentExecute` rejects a blank
   * (empty or whitespace-only) key AND a key that fails the same
   * printable-ASCII/no-control-character/200-char-max shape contract as
   * `IdempotencyKeyHeader` (`../adapters/http/server-schemas.js`) — a
   * deliberate duplication, not an oversight, so a future caller that
   * invokes this port directly (bypassing `request.ts`/HTTP entirely, as
   * `agent-orchestrator`'s planned `ApproveIntent` will) gets the same
   * validation the HTTP route gives for free, instead of silently handing
   * Inngest an unvalidated string.
   */
  readonly idempotencyKey?: string;
}

export interface WorkflowRuns {
  startPaymentExecute(
    data: PaymentExecuteRequested,
    options?: StartPaymentExecuteOptions,
  ): Promise<{ readonly eventId: string }>;
  /** `null` when Inngest has no record of this event id at all. */
  findByEventId(eventId: string): Promise<WorkflowRunSnapshot | null>;
}

/** Raised when Inngest's API can't be reached or answers with a server-side failure (>= 500). */
export class WorkflowEngineUnavailableError extends Error {
  readonly code = "workflow_engine_unavailable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
