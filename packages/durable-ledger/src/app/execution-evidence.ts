import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { WorkflowRuns } from "../ports/workflow-runs.js";
import type { ExecutionJournal } from "../ports/execution-journal.js";
import type { PayCoreClient } from "../ports/pay-core-client.js";
import type { LedgerEntry } from "../domain/entry.js";
import { PostingGroup } from "../domain/entry.js";
import { stepOperationId } from "../workflow/operation-id.js";
import { stepIdempotencyKey } from "../workflow/idempotency-key.js";
import { recordAttempt } from "../workflow/record-attempt.js";
import { ExecutionEvidenceError } from "../domain/errors.js";

export interface ExecutionEvidenceDeps {
  readonly ledger: LedgerRepository;
  readonly runs: WorkflowRuns;
  readonly journal?: ExecutionJournal;
  readonly payCore?: PayCoreClient;
  /** Explicit operator assertion: this instance talks only to a simulator. */
  readonly demoResendEnabled?: boolean;
}

/** A completed run plus its deterministic, canonical capture group is proof.
 * Inngest REST output is deliberately not used: the local API returns "".
 */
function captureProof(entries: readonly LedgerEntry[], operationId: string) {
  const first = entries[0];
  if (
    entries.length !== 2 ||
    first === undefined ||
    !/^[A-Z]{3}$/.test(first.amount.currency) ||
    entries.some(
      (e) =>
        e.operationId !== operationId ||
        e.paymentId !== first.paymentId ||
        !e.paymentId ||
        e.entryType !== "capture" ||
        e.reversesOperationId !== null ||
        e.amount.amount !== first.amount.amount ||
        e.amount.currency !== first.amount.currency ||
        !Number.isSafeInteger(e.amount.amount) ||
        e.amount.amount <= 0,
    )
  )
    return null;
  const clearing = entries.find(
    (e) =>
      e.account.toString() === "acquirer_clearing" && e.direction === "debit",
  );
  const merchant = entries.find(
    (e) =>
      /^merchant:[A-Za-z0-9_-]{1,64}$/.test(e.account.toString()) &&
      e.direction === "credit",
  );
  if (clearing === undefined || merchant === undefined) return null;
  return {
    paymentId: first.paymentId,
    currency: first.amount.currency,
    capturedAmount: first.amount.amount,
    operationId,
  };
}

export class ExecutionEvidence {
  constructor(private readonly deps: ExecutionEvidenceDeps) {}
  async read(
    eventId: string,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
    includePayment = true,
  ) {
    const run = await this.deps.runs.findByEventId(eventId, options);
    if (run === null)
      throw new ExecutionEvidenceError(
        404,
        "workflow_run_not_found",
        "Workflow not found",
      );
    const operationId =
      run.runId === null ? null : stepOperationId(run.runId, "post-ledger");
    const entries =
      operationId === null
        ? []
        : await this.deps.ledger.findByOperationId(operationId);
    const proof =
      operationId === null ? null : captureProof(entries, operationId);
    let attempts: Awaited<ReturnType<ExecutionJournal["findByRunId"]>> = [];
    let journalAvailable = this.deps.journal !== undefined;
    if (run.runId !== null && this.deps.journal !== undefined) {
      try {
        attempts = await this.deps.journal.findByRunId(run.runId);
      } catch {
        journalAvailable = false;
      }
    }
    const paymentIds = new Set(
      attempts
        .map((a) => a.paymentId)
        .filter((id): id is string => id !== null),
    );
    const paymentId =
      proof?.paymentId ??
      (journalAvailable && paymentIds.size === 1
        ? [...paymentIds][0]
        : undefined);
    let payment: {
      source: "pay-core";
      availability: "known" | "unknown";
      snapshot: {
        id: string;
        status: string;
        currency: string;
        amountAuthorized: number;
        capturedAmount: number;
        refundedAmount: number;
      } | null;
    } = { source: "pay-core", availability: "unknown", snapshot: null };
    if (
      includePayment &&
      paymentId !== undefined &&
      this.deps.payCore !== undefined
    ) {
      try {
        const snapshot = await this.deps.payCore.getPayment(paymentId, options);
        if (
          snapshot.id === paymentId &&
          /^[A-Z]{3}$/.test(snapshot.currency) &&
          [
            snapshot.amountAuthorized,
            snapshot.capturedAmount,
            snapshot.refundedAmount,
          ].every((n) => Number.isSafeInteger(n) && n >= 0)
        )
          payment = {
            source: "pay-core",
            availability: "known",
            snapshot: {
              id: snapshot.id,
              status: snapshot.status,
              currency: snapshot.currency,
              amountAuthorized: snapshot.amountAuthorized,
              capturedAmount: snapshot.capturedAmount,
              refundedAmount: snapshot.refundedAmount,
            },
          };
      } catch {
        /* Missing projection is explicitly unknown, independent of ledger proof. */
      }
    }
    return {
      payment,
      statusSource: "inngest" as const,
      run: {
        eventId: run.eventId,
        runId: run.runId,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        needsReview: run.needsReview,
      },
      journal: {
        available: journalAvailable,
        completeness: "not_guaranteed" as const,
        attempts,
      },
      ledger: {
        source: "ledger" as const,
        entries: entries.map((e) => ({
          id: e.id,
          operationId: e.operationId,
          account: e.account.toString(),
          direction: e.direction,
          amount: e.amount.toJSON(),
          paymentId: e.paymentId,
          entryType: e.entryType,
          reversesOperationId: e.reversesOperationId,
          createdAt: e.createdAt.toISOString(),
        })),
        proof,
      },
      resendAvailable:
        this.deps.demoResendEnabled === true &&
        this.deps.payCore !== undefined &&
        run.status === "completed" &&
        proof !== null,
    };
  }
  async resend(
    eventId: string,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) {
    if (this.deps.demoResendEnabled !== true || this.deps.payCore === undefined)
      throw new ExecutionEvidenceError(404, "not_found", "Not found");
    const evidence = await this.read(eventId, options, false);
    const { proof } = evidence.ledger;
    const { runId } = evidence.run;
    if (evidence.run.status !== "completed" || proof === null || runId === null)
      throw new ExecutionEvidenceError(
        409,
        "resend_unavailable",
        "A completed run with matching capture entries is required",
      );
    // Validate and reconstruct the exact stored drafts BEFORE any effect.
    const stored = await this.deps.ledger.findByOperationId(proof.operationId);
    const rechecked = captureProof(stored, proof.operationId);
    if (
      rechecked === null ||
      JSON.stringify(rechecked) !== JSON.stringify(proof)
    )
      throw new ExecutionEvidenceError(
        409,
        "resend_unavailable",
        "Capture proof changed",
      );
    const group = PostingGroup.create({
      operationId: proof.operationId,
      paymentId: proof.paymentId,
      entryType: "capture",
      entries: stored.map((e) => ({
        account: e.account,
        direction: e.direction,
        amount: e.amount,
      })),
    });
    const assertActive = () => {
      if (options?.signal?.aborted)
        throw new ExecutionEvidenceError(
          409,
          "delivery_unknown",
          "Delivery deadline expired; outcome requires inspection",
        );
    };
    assertActive();
    const key = stepIdempotencyKey(runId, "capture");
    const capture = await recordAttempt(
      this.deps.journal,
      {
        runId,
        eventId,
        step: "capture",
        phase: "resend",
        paymentId: proof.paymentId,
        operationId: null,
        idempotencyKey: key,
      },
      () =>
        this.deps.payCore!.capturePayment(
          { paymentId: proof.paymentId },
          { idempotencyKey: key, ...options },
        ),
      (r) => r.id,
    );
    if (
      capture.id !== proof.paymentId ||
      capture.status !== "captured" ||
      capture.currency !== proof.currency ||
      capture.capturedAmount !== proof.capturedAmount
    )
      throw new ExecutionEvidenceError(
        409,
        "capture_result_mismatch",
        "The returned capture result differs from the original ledger proof",
      );
    assertActive();
    const result = await recordAttempt(
      this.deps.journal,
      {
        runId,
        eventId,
        step: "post-ledger",
        phase: "resend",
        paymentId: proof.paymentId,
        operationId: proof.operationId,
        idempotencyKey: null,
      },
      () => this.deps.ledger.post(group),
      () => proof.paymentId,
    );
    const ids = (entries: readonly { readonly id: string }[]) =>
      entries.map((e) => e.id).sort();
    return {
      capture: {
        id: capture.id,
        status: capture.status,
        currency: capture.currency,
        capturedAmount: capture.capturedAmount,
        refundedAmount: capture.refundedAmount,
      },
      ledgerOutcome: result.outcome,
      originalEntryIds: ids(stored),
      returnedEntryIds: ids(result.entries),
      unchangedEntries:
        JSON.stringify(ids(stored)) === JSON.stringify(ids(result.entries)),
      entryCountBefore: stored.length,
      entryCountAfter: result.entries.length,
    };
  }
}
