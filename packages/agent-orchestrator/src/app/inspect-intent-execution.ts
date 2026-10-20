import type { ResendResult } from "../ports/execution-evidence.js";
import { AgentCoreClientError } from "../ports/agent-core-client.js";
import type { GetIntent } from "./get-intent.js";
import type { AgentCoreClient } from "../ports/agent-core-client.js";
import {
  IntentNotFoundError,
  ExecutionInspectionError,
} from "../domain/errors.js";

/** Owns the customer boundary before any downstream inspection or resend. */
export class InspectIntentExecution {
  constructor(
    private readonly intents: Pick<GetIntent, "execute">,
    private readonly core: AgentCoreClient | undefined,
    private readonly resendEnabled: boolean,
    private readonly batchOptions?: {
      readonly deadlineMs?: number;
      readonly perCallMs?: number;
    },
  ) {}
  private async owned(intentId: string, customerId: string) {
    const view = await this.intents.execute(intentId);
    if (view.customerId !== customerId) throw new IntentNotFoundError(intentId);
    return view;
  }
  async read(intentId: string, customerId: string) {
    const view = await this.owned(intentId, customerId);
    if (view.durableLedgerEventId === null) return { evidence: null };
    if (this.core?.getExecutionEvidence === undefined)
      throw new ExecutionInspectionError(
        503,
        "evidence_unavailable",
        "Execution evidence is unavailable",
      );
    const evidence = await this.core.getExecutionEvidence(
      view.durableLedgerEventId,
    );
    return {
      evidence: {
        ...evidence,
        resendAvailable: this.resendEnabled && evidence.resendAvailable,
      },
    };
  }
  async resend(intentId: string, customerId: string) {
    const view = await this.owned(intentId, customerId);
    if (!this.resendEnabled || this.core?.resendExecution === undefined)
      throw new ExecutionInspectionError(404, "not_found", "Not found");
    if (view.status !== "completed" || view.durableLedgerEventId === null)
      throw new ExecutionInspectionError(
        409,
        "resend_unavailable",
        "A completed simulated payment is required",
      );
    return this.core.resendExecution(view.durableLedgerEventId);
  }
  async redeliver(intentId: string, customerId: string) {
    const view = await this.owned(intentId, customerId);
    if (!this.resendEnabled || this.core?.resendExecution === undefined)
      throw new ExecutionInspectionError(404, "not_found", "Not found");
    if (view.status !== "completed" || view.durableLedgerEventId === null)
      throw new ExecutionInspectionError(
        409,
        "resend_unavailable",
        "A completed simulated payment is required",
      );
    type Receipt = {
      delivery: number;
      status: "fulfilled" | "failed" | "unknown" | "not_attempted";
      result: ResendResult | null;
      reason: string | null;
    };
    const receipts: Receipt[] = [];
    const deadline =
      Date.now() + Math.min(9000, this.batchOptions?.deadlineMs ?? 9000);
    let baseline: ResendResult | null = null;
    for (let delivery = 1; delivery <= 10; delivery++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        receipts.push({
          delivery,
          status: "not_attempted",
          result: null,
          reason: "batch_deadline",
        });
        break;
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = Math.min(
          800,
          this.batchOptions?.perCallMs ?? 800,
          remaining,
        );
        const result = await Promise.race([
          this.core.resendExecution(view.durableLedgerEventId, {
            timeoutMs,
            signal: controller.signal,
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("delivery_deadline"));
            }, timeoutMs);
          }),
        ]);
        const sameIds =
          JSON.stringify([...result.originalEntryIds].sort()) ===
          JSON.stringify([...result.returnedEntryIds].sort());
        const matches =
          result.ledgerOutcome === "already_posted" &&
          result.unchangedEntries &&
          sameIds &&
          result.entryCountBefore === 2 &&
          result.entryCountAfter === 2 &&
          (baseline === null ||
            (baseline.capture.id === result.capture.id &&
              JSON.stringify([...baseline.originalEntryIds].sort()) ===
                JSON.stringify([...result.originalEntryIds].sort())));
        receipts.push({
          delivery,
          status: matches ? "fulfilled" : "failed",
          result,
          reason: matches ? null : "identity_or_posting_mismatch",
        });
        if (!matches) break;
        baseline = result;
      } catch (error) {
        const definite =
          error instanceof AgentCoreClientError &&
          error.ledgerCode !== undefined &&
          [
            "not_found",
            "resend_unavailable",
            "capture_result_mismatch",
          ].includes(error.ledgerCode);
        receipts.push({
          delivery,
          status: definite ? "failed" : "unknown",
          result: null,
          reason: definite ? "delivery_rejected" : "delivery_outcome_unknown",
        });
        break;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    while (receipts.length < 10)
      receipts.push({
        delivery: receipts.length + 1,
        status: "not_attempted",
        result: null,
        reason: "batch_stopped",
      });
    return {
      receipts,
      invariantVerified: receipts.every((r) => r.status === "fulfilled"),
      attempted: receipts.filter((r) => r.status !== "not_attempted").length,
    };
  }
}
