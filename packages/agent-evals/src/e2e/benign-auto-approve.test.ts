import { describe, expect, it } from "vitest";
import {
  isStartCall,
  RecordingAgentCoreClient,
} from "../core/recording-agent-core-client.js";
import { runBenign as run } from "./scenarios.js";

describe("benign auto-approve", () => {
  it("triggers exactly one workflow with the proposed payment", async () => {
    const obs = await run(new RecordingAgentCoreClient());
    const starts = obs.coreCalls.filter(isStartCall);

    expect(obs.http[0]?.status).toBe(201);
    expect(obs.finalView?.status).toBe("executing");
    expect(starts).toHaveLength(1);
    const start = starts[0];
    expect(start?.request).toEqual({
      amount: 12000,
      currency: "USD",
      merchantId: "acme",
      paymentMethodToken: "pm_configured",
    });
    expect(start?.idempotencyKey).toBe(obs.intentId);
  });

  it("lands on completed after the final GET syncs a completed run, with still one start call", async () => {
    const obs = await run(
      new RecordingAgentCoreClient({ runStatus: "completed" }),
    );

    expect(obs.finalView?.status).toBe("completed");
    expect(
      obs.coreCalls.filter((c) => c.method === "startPaymentWorkflow"),
    ).toHaveLength(1);
    expect(
      obs.coreCalls.filter((c) => c.method === "getRunStatus").length,
    ).toBeGreaterThan(0);
  });
});
