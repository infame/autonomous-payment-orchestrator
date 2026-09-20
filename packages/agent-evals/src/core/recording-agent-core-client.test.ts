import { describe, expect, it } from "vitest";
import { AgentCoreRunNotFoundError } from "@apo/agent-orchestrator";
import { RecordingAgentCoreClient } from "./recording-agent-core-client.js";

const REQ = {
  amount: 100,
  currency: "USD",
  merchantId: "acme",
  paymentMethodToken: "pm_x",
};

describe("RecordingAgentCoreClient", () => {
  it("mints distinct eventIds for same-key sends but creates one real run", async () => {
    const client = new RecordingAgentCoreClient();
    const a = await client.startPaymentWorkflow(REQ, { idempotencyKey: "k" });
    const b = await client.startPaymentWorkflow(REQ, { idempotencyKey: "k" });

    expect(a.eventId).not.toBe(b.eventId);
    expect(client.realRunCount).toBe(1);
    expect(client.startCalls).toHaveLength(2);
    expect(client.startCalls.map((c) => c.index)).toEqual([0, 1]);
  });

  it("keeps a dud queued forever even when the real run settles", async () => {
    const client = new RecordingAgentCoreClient();
    const real = await client.startPaymentWorkflow(REQ, {
      idempotencyKey: "k",
    });
    const dud = await client.startPaymentWorkflow(REQ, { idempotencyKey: "k" });
    client.settleRun(real.eventId, { status: "completed" });

    expect((await client.getRunStatus(real.eventId)).status).toBe("completed");
    expect((await client.getRunStatus(dud.eventId)).status).toBe("queued");
    expect(client.calls.map((c) => c.method)).toEqual([
      "startPaymentWorkflow",
      "startPaymentWorkflow",
      "getRunStatus",
      "getRunStatus",
    ]);
  });

  it("throws AgentCoreRunNotFoundError for an unknown eventId", async () => {
    const client = new RecordingAgentCoreClient();
    await expect(client.getRunStatus("nope")).rejects.toBeInstanceOf(
      AgentCoreRunNotFoundError,
    );
    expect(client.calls).toEqual([
      { index: 0, method: "getRunStatus", eventId: "nope", snapshot: null },
    ]);
  });

  it("uses a valid custom eventIdPrefix", async () => {
    const client = new RecordingAgentCoreClient({ eventIdPrefix: "evt_x_" });
    const { eventId } = await client.startPaymentWorkflow(REQ);
    expect(eventId.startsWith("evt_x_")).toBe(true);
  });

  it.each(["", "   ", "evt_\u00e9_", "evt_\n"])(
    "rejects a blank or non-printable-ASCII eventIdPrefix %j",
    (prefix) => {
      expect(
        () => new RecordingAgentCoreClient({ eventIdPrefix: prefix }),
      ).toThrow(/eventIdPrefix/);
    },
  );

  it("reflects settleRun in the next snapshot and rejects unknown ids", async () => {
    const client = new RecordingAgentCoreClient();
    const { eventId } = await client.startPaymentWorkflow(REQ);
    client.settleRun(eventId, { status: "failed", failureMessage: "boom" });

    const snap = await client.getRunStatus(eventId);
    expect(snap.status).toBe("failed");
    expect(snap.failureMessage).toBe("boom");
    expect(() => client.settleRun("nope", { status: "failed" })).toThrow();
  });
});
