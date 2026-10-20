/** Durable-ledger wire contract, independently declared across HTTP boundary. */
export interface ExecutionEvidenceView {
  readonly statusSource: "inngest";
  readonly payment?:
    | {
        readonly source: "pay-core";
        readonly availability: "known" | "unknown";
        readonly snapshot: {
          readonly id: string;
          readonly status: string;
          readonly currency: string;
          readonly amountAuthorized: number;
          readonly capturedAmount: number;
          readonly refundedAmount: number;
        } | null;
      }
    | undefined;
  readonly run: {
    readonly eventId: string;
    readonly runId: string | null;
    readonly status: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly needsReview: boolean;
  };
  readonly journal: {
    readonly available: boolean;
    readonly completeness: "not_guaranteed";
    readonly attempts: readonly {
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
    }[];
  };
  readonly ledger: {
    readonly source: "ledger";
    readonly proof: {
      readonly paymentId: string;
      readonly currency: string;
      readonly capturedAmount: number;
      readonly operationId: string;
    } | null;
    readonly entries: readonly {
      readonly id: string;
      readonly operationId: string;
      readonly account: string;
      readonly direction: string;
      readonly amount: { readonly amount: number; readonly currency: string };
      readonly paymentId: string;
      readonly entryType: string;
      readonly reversesOperationId: string | null;
      readonly createdAt: string;
    }[];
  };
  readonly resendAvailable: boolean;
}
export interface ResendResult {
  readonly capture: {
    readonly id: string;
    readonly status: string;
    readonly currency: string;
    readonly capturedAmount: number;
    readonly refundedAmount: number;
  };
  readonly ledgerOutcome: "posted" | "already_posted";
  readonly originalEntryIds: readonly string[];
  readonly returnedEntryIds: readonly string[];
  readonly unchangedEntries: boolean;
  readonly entryCountBefore: number;
  readonly entryCountAfter: number;
}
export interface ExecutionEvidenceClient {
  getExecutionEvidence(eventId: string): Promise<ExecutionEvidenceView>;
  resendExecution(
    eventId: string,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ResendResult>;
}
