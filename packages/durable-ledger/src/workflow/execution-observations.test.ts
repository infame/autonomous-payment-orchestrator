import { describe, expect, it, vi } from "vitest";
import { runPaymentExecute } from "./payment-execute.js";
import { FakeWorkflowStep } from "./fake-workflow-step.js";
import {
  FakePayCoreClient,
  authorizedPaymentResponse,
  capturedPaymentResponse,
} from "./fake-pay-core-client.js";
import { InMemoryLedgerRepository } from "../adapters/memory/in-memory-ledger-repository.js";
import { PayCoreUnavailableError } from "../ports/pay-core-errors.js";
import type {
  ExecutionAttempt,
  ExecutionJournal,
} from "../ports/execution-journal.js";
import { recordAttempt } from "./record-attempt.js";

export class MemoryJournal implements ExecutionJournal {
  readonly rows = new Map<string, ExecutionAttempt>();
  async start(a: ExecutionAttempt) {
    this.rows.set(a.id, a);
    await Promise.resolve();
  }
  async finish(
    id: string,
    r: Pick<
      ExecutionAttempt,
      "paymentId" | "outcome" | "errorCode" | "endedAt"
    >,
  ) {
    const a = this.rows.get(id);
    if (a) this.rows.set(id, { ...a, ...r });
    await Promise.resolve();
  }
  async findByRunId(runId: string) {
    await Promise.resolve();
    return [...this.rows.values()].filter((a) => a.runId === runId);
  }
}
class RetryCaptureStep extends FakeWorkflowStep {
  override async run<T>(id: string, fn: () => Promise<T>) {
    try {
      return await super.run(id, fn);
    } catch (error) {
      if (id !== "capture") throw error;
      return super.run(id, fn);
    }
  }
}

describe("actual execution observations", () => {
  it("records real capture failure and retry inside workflow callbacks without credentials", async () => {
    const journal = new MemoryJournal();
    const payCore = new FakePayCoreClient()
      .scriptCreatePayment({
        kind: "resolve",
        response: authorizedPaymentResponse({ id: "payment" }),
      })
      .scriptCapturePayment({
        kind: "reject",
        error: new PayCoreUnavailableError("secret provider body", {
          operation: "capture_payment",
          status: 503,
          payCoreCode: "private",
        }),
      })
      .scriptCapturePayment({
        kind: "resolve",
        response: capturedPaymentResponse("payment"),
      });
    const result = await runPaymentExecute(
      new RetryCaptureStep(),
      {
        runId: "run-observed",
        eventId: "event-observed",
        attempt: 0,
        data: {
          amount: 12000,
          currency: "USD",
          merchantId: "vendor",
          paymentMethodToken: "secret-token",
        },
      },
      { payCore, ledger: new InMemoryLedgerRepository(), journal },
    );
    expect(result.status).toBe("captured");
    const rows = await journal.findByRunId("run-observed");
    expect(rows.map((r) => [r.step, r.outcome])).toEqual([
      ["authorize", "succeeded"],
      ["capture", "failed"],
      ["capture", "succeeded"],
      ["post-ledger", "succeeded"],
    ]);
    expect(rows[1]?.idempotencyKey).toBe(rows[2]?.idempotencyKey);
    expect(JSON.stringify(rows)).not.toMatch(
      /secret-token|secret provider body|private/,
    );
  });
  it("keeps payment and ledger success independent of journal start/finish failure", async () => {
    const finish = vi.fn().mockRejectedValue(new Error("down"));
    const journal: ExecutionJournal = {
      start: vi.fn().mockRejectedValue(new Error("down")),
      finish,
      findByRunId: vi.fn().mockRejectedValue(new Error("down")),
    };
    const payCore = new FakePayCoreClient()
      .scriptCreatePayment({
        kind: "resolve",
        response: authorizedPaymentResponse(),
      })
      .scriptCapturePayment({
        kind: "resolve",
        response: capturedPaymentResponse("payment"),
      });
    const result = await runPaymentExecute(
      new FakeWorkflowStep(),
      {
        runId: "journal-down",
        attempt: 0,
        data: {
          amount: 12000,
          currency: "USD",
          merchantId: "vendor",
          paymentMethodToken: "token",
        },
      },
      { payCore, ledger: new InMemoryLedgerRepository(), journal },
    );
    expect(result.ledgerOutcome).toBe("posted");
    expect(finish).toHaveBeenCalledTimes(3);
  });
  it("leaves an unfinished start explicit and never changes the business error", async () => {
    const journal = new MemoryJournal();
    journal.finish = vi.fn().mockRejectedValue(new Error("offline"));
    const error = new Error("business failure");
    await expect(
      recordAttempt(
        journal,
        {
          runId: "r",
          eventId: null,
          step: "capture",
          phase: "workflow",
          paymentId: "p",
          operationId: null,
          idempotencyKey: "k",
        },
        () => Promise.reject(error),
        () => "p",
      ),
    ).rejects.toBe(error);
    expect([...journal.rows.values()][0]?.outcome).toBe("started");
  });
  it("bounds a hung journal without delaying the operation indefinitely", async () => {
    const journal: ExecutionJournal = {
      start: () => new Promise(() => {}),
      finish: () => new Promise(() => {}),
      findByRunId: () => Promise.resolve([]),
    };
    await expect(
      recordAttempt(
        journal,
        {
          runId: "r",
          eventId: null,
          step: "capture",
          phase: "workflow",
          paymentId: "p",
          operationId: null,
          idempotencyKey: "k",
        },
        () => Promise.resolve("done"),
        () => "p",
      ),
    ).resolves.toBe("done");
  });
});
