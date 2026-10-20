import { describe, expect, it, vi } from "vitest";
import { ExecutionEvidence } from "./execution-evidence.js";
import { InMemoryLedgerRepository } from "../adapters/memory/in-memory-ledger-repository.js";
import { LedgerEntry, PostingGroup } from "../domain/entry.js";
import { Money } from "../domain/money.js";
import { stepOperationId } from "../workflow/operation-id.js";
import { stepIdempotencyKey } from "../workflow/idempotency-key.js";
import {
  FakePayCoreClient,
  capturedPaymentResponse,
} from "../workflow/fake-pay-core-client.js";
import type { WorkflowRuns } from "../ports/workflow-runs.js";

async function setup(status = "completed", enabled = true) {
  const ledger = new InMemoryLedgerRepository();
  const runId = "run-proof";
  const runs: WorkflowRuns = {
    startPaymentExecute: vi.fn(),
    findByEventId: vi.fn().mockResolvedValue({
      eventId: "event",
      runId,
      status,
      startedAt: null,
      endedAt: null,
      needsReview: false,
      failureMessage: null,
    }),
  };
  const payCore = new FakePayCoreClient().scriptCapturePayment({
    kind: "resolve",
    response: capturedPaymentResponse("proof-payment", {
      capturedAmount: 12000,
    }),
  });
  const group = PostingGroup.forCapture({
    operationId: stepOperationId(runId, "post-ledger"),
    paymentId: "proof-payment",
    merchantId: "vendor",
    amount: Money.of(12000, "USD"),
  });
  await ledger.post(group);
  return {
    ledger,
    runs,
    payCore,
    group,
    service: new ExecutionEvidence({
      ledger,
      runs,
      payCore,
      demoResendEnabled: enabled,
    }),
  };
}
describe("completed capture proof and identical resend", () => {
  it("resends the exact original capture body/key and returns unchanged original ledger ids", async () => {
    const { service, payCore, ledger, group } = await setup();
    const result = await service.resend("event");
    expect(payCore.calls[0]).toMatchObject({
      method: "capture_payment",
      request: { paymentId: "proof-payment" },
      idempotencyKey: stepIdempotencyKey("run-proof", "capture"),
    });
    expect(payCore.calls[0]?.request).toEqual({ paymentId: "proof-payment" });
    expect(result.ledgerOutcome).toBe("already_posted");
    expect(result.unchangedEntries).toBe(true);
    expect(result.returnedEntryIds).toEqual(
      group.entries.map((e) => e.id).sort(),
    );
    expect(await ledger.findByPaymentId("proof-payment")).toHaveLength(2);
  });
  it.each(["running", "failed", "cancelled"])(
    "refuses %s before any effects",
    async (status) => {
      const { service, payCore } = await setup(status);
      await expect(service.resend("event")).rejects.toMatchObject({
        code: "resend_unavailable",
      });
      expect(payCore.calls).toHaveLength(0);
    },
  );
  it("fails closed when disabled", async () => {
    const { service, payCore } = await setup("completed", false);
    await expect(service.resend("event")).rejects.toMatchObject({
      status: 404,
    });
    expect(payCore.calls).toHaveLength(0);
  });
  it.each(["payment", "currency", "amount", "operation", "type", "reversal"])(
    "refuses mismatched %s proof before calling capture",
    async (field) => {
      const { ledger, runs, payCore, group } = await setup();
      const entry = group.entries[0]!;
      const state = entry.toState();
      const changed = LedgerEntry.fromState({
        ...state,
        ...(field === "payment" ? { paymentId: "other" } : {}),
        ...(field === "currency"
          ? { amount: Money.of(state.amount.amount, "EUR") }
          : {}),
        ...(field === "amount" ? { amount: Money.of(1, "USD") } : {}),
        ...(field === "operation"
          ? { operationId: stepOperationId("other-run", "post-ledger") }
          : {}),
        ...(field === "type" ? { entryType: "refund" as const } : {}),
        ...(field === "reversal"
          ? { reversesOperationId: stepOperationId("other-run", "post-ledger") }
          : {}),
      });
      vi.spyOn(ledger, "findByOperationId").mockResolvedValue([
        changed,
        group.entries[1]!,
      ]);
      await expect(
        new ExecutionEvidence({
          ledger,
          runs,
          payCore,
          demoResendEnabled: true,
        }).resend("event"),
      ).rejects.toMatchObject({ code: "resend_unavailable" });
      expect(payCore.calls).toHaveLength(0);
    },
  );
  it("rejects a noncanonical capture group before any effects", async () => {
    const { ledger, runs, payCore, group } = await setup();
    const find = vi
      .spyOn(ledger, "findByOperationId")
      .mockResolvedValue([group.entries[0]!]);
    await expect(
      new ExecutionEvidence({
        ledger,
        runs,
        payCore,
        demoResendEnabled: true,
      }).resend("event"),
    ).rejects.toMatchObject({ code: "resend_unavailable" });
    expect(payCore.calls).toHaveLength(0);
    expect(find).toHaveBeenCalled();
  });
  it("isolates entries by deterministic run operation and exposes journal unavailability honestly", async () => {
    const { ledger, runs, payCore } = await setup();
    await ledger.post(
      PostingGroup.forCapture({
        operationId: stepOperationId("other-run", "post-ledger"),
        paymentId: "other-payment",
        merchantId: "other",
        amount: Money.of(500, "USD"),
      }),
    );
    const evidence = await new ExecutionEvidence({
      ledger,
      runs,
      payCore,
      journal: {
        start: vi.fn(),
        finish: vi.fn(),
        findByRunId: vi.fn().mockRejectedValue(new Error("down")),
      },
    }).read("event");
    expect(evidence.journal.available).toBe(false);
    expect(evidence.ledger.entries).toHaveLength(2);
    expect(
      evidence.ledger.entries.every((e) => e.paymentId === "proof-payment"),
    ).toBe(true);
  });
});

describe("authoritative safe payment projection", () => {
  it("reads a declined payment from its unique trusted run correlation without implying there was no payment record", async () => {
    const ledger = new InMemoryLedgerRepository();
    const payCore = new FakePayCoreClient().scriptGetPayment({
      kind: "resolve",
      response: {
        id: "declined",
        status: "failed",
        currency: "USD",
        amountAuthorized: 0,
        capturedAmount: 0,
        refundedAmount: 0,
        providerRef: "private-provider-ref",
        failureReason: "private reason",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const runs: WorkflowRuns = {
      startPaymentExecute: vi.fn(),
      findByEventId: vi
        .fn()
        .mockResolvedValue({
          eventId: "event",
          runId: "declined-run",
          status: "failed",
          startedAt: null,
          endedAt: null,
          needsReview: false,
          failureMessage: null,
        }),
    };
    const journal = {
      start: vi.fn(),
      finish: vi.fn(),
      findByRunId: vi.fn().mockResolvedValue([{ paymentId: "declined" }]),
    };
    const value = await new ExecutionEvidence({
      ledger,
      runs,
      payCore,
      journal,
    }).read("event");
    expect(value.payment.snapshot).toMatchObject({
      id: "declined",
      status: "failed",
      capturedAmount: 0,
    });
    expect(value.ledger.proof).toBeNull();
    expect(JSON.stringify(value)).not.toContain("private-provider-ref");
    expect(JSON.stringify(value)).not.toContain("private reason");
  });
  it("keeps the money outcome unknown when neither proof nor reliable journal identifies a payment", async () => {
    const ledger = new InMemoryLedgerRepository(),
      payCore = new FakePayCoreClient();
    const runs: WorkflowRuns = {
      startPaymentExecute: vi.fn(),
      findByEventId: vi
        .fn()
        .mockResolvedValue({
          eventId: "event",
          runId: "unobserved",
          status: "failed",
          startedAt: null,
          endedAt: null,
          needsReview: false,
          failureMessage: null,
        }),
    };
    const value = await new ExecutionEvidence({ ledger, runs, payCore }).read(
      "event",
    );
    expect(value.payment).toMatchObject({
      availability: "unknown",
      snapshot: null,
    });
    expect(payCore.calls).toHaveLength(0);
  });
});
