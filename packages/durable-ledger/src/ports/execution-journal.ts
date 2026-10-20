/** Sanitized observations, independent of workflow status and ledger truth. */
export interface ExecutionAttempt {
  readonly id: string;
  readonly runId: string;
  readonly eventId: string | null;
  readonly step: "authorize" | "capture" | "post-ledger";
  readonly phase: "workflow" | "resend";
  readonly paymentId: string | null;
  readonly operationId: string | null;
  readonly idempotencyKey: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: "started" | "succeeded" | "failed";
  readonly errorCode: string | null;
}
export interface ExecutionJournal {
  start(attempt: ExecutionAttempt): Promise<void>;
  finish(
    id: string,
    result: Pick<
      ExecutionAttempt,
      "paymentId" | "outcome" | "errorCode" | "endedAt"
    >,
  ): Promise<void>;
  findByRunId(runId: string): Promise<readonly ExecutionAttempt[]>;
}
