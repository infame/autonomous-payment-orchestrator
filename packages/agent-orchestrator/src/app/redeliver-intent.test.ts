import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectIntentExecution } from "./inspect-intent-execution.js";
import { FakeAgentCoreClient } from "../adapters/memory/fake-agent-core-client.js";
import { AgentCoreUnexpectedResponseError } from "../ports/agent-core-client.js";
const view = {
  id: "intent",
  customerId: "owner",
  text: "source",
  status: "completed" as const,
  proposal: null,
  policyVerdict: null,
  durableLedgerEventId: "event",
  clarificationAnswer: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const result = {
  capture: {
    id: "payment",
    status: "captured",
    currency: "USD",
    capturedAmount: 50000,
    refundedAmount: 0,
  },
  ledgerOutcome: "already_posted" as const,
  originalEntryIds: ["debit", "credit"],
  returnedEntryIds: ["credit", "debit"],
  unchangedEntries: true,
  entryCountBefore: 2,
  entryCountAfter: 2,
};
afterEach(() => vi.useRealTimers());
describe("ten sequential exact deliveries", () => {
  it("uses one owned event and same entries for all ten, never starts a workflow", async () => {
    let active = 0,
      maxActive = 0;
    const resend = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      await Promise.resolve();
      active--;
      return result;
    });
    const core = Object.assign(new FakeAgentCoreClient(), {
      resendExecution: resend,
    });
    const operation = new InspectIntentExecution(
      { execute: vi.fn().mockResolvedValue(view) },
      core,
      true,
    );
    const batch = await operation.redeliver("intent", "owner");
    expect(batch.invariantVerified).toBe(true);
    expect(batch.receipts).toHaveLength(10);
    expect(resend).toHaveBeenCalledTimes(10);
    expect(maxActive).toBe(1);
    expect(core.calls).toHaveLength(0);
    for (const [event, options] of resend.mock.calls as [
      string,
      { timeoutMs: number; signal: AbortSignal },
    ][]) {
      expect(event).toBe("event");
      expect(options.timeoutMs).toBeLessThanOrEqual(800);
      expect(options.signal.aborted).toBe(false);
    }
  });
  it("does not touch another customer's workflow", async () => {
    const resend = vi.fn();
    const core = Object.assign(new FakeAgentCoreClient(), {
      resendExecution: resend,
    });
    await expect(
      new InspectIntentExecution(
        { execute: vi.fn().mockResolvedValue(view) },
        core,
        true,
      ).redeliver("intent", "intruder"),
    ).rejects.toMatchObject({ code: "intent_not_found" });
    expect(resend).not.toHaveBeenCalled();
  });
  it("stops after an uncertain409 and marks remaining deliveries not attempted", async () => {
    const resend = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockRejectedValue(
        new AgentCoreUnexpectedResponseError("deadline", {
          operation: "resend_execution",
          status: 409,
          ledgerCode: "delivery_unknown",
        }),
      );
    const core = Object.assign(new FakeAgentCoreClient(), {
      resendExecution: resend,
    });
    const batch = await new InspectIntentExecution(
      { execute: vi.fn().mockResolvedValue(view) },
      core,
      true,
    ).redeliver("intent", "owner");
    expect(batch.invariantVerified).toBe(false);
    expect(batch.receipts.slice(0, 3).map((r) => r.status)).toEqual([
      "fulfilled",
      "unknown",
      "not_attempted",
    ]);
    expect(resend).toHaveBeenCalledTimes(2);
  });
  it("bounds an unresponsive delivery, aborts it and launches nothing after the deadline", async () => {
    vi.useFakeTimers();
    const resend = vi.fn().mockImplementation(() => new Promise(() => {}));
    const core = Object.assign(new FakeAgentCoreClient(), {
      resendExecution: resend,
    });
    const operation = new InspectIntentExecution(
      { execute: vi.fn().mockResolvedValue(view) },
      core,
      true,
      { deadlineMs: 30, perCallMs: 50 },
    );
    const pending = operation.redeliver("intent", "owner");
    await vi.advanceTimersByTimeAsync(31);
    const batch = await pending;
    expect(batch.receipts[0]?.status).toBe("unknown");
    expect(
      batch.receipts.slice(1).every((r) => r.status === "not_attempted"),
    ).toBe(true);
    expect(
      (resend.mock.calls[0]?.[1] as { signal: AbortSignal }).signal.aborted,
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(resend).toHaveBeenCalledTimes(1);
  });
});
