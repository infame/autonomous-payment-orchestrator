import { describe, expect, it } from "vitest";
import { paymentProposal } from "@apo/agent-orchestrator";
import {
  isStartCall,
  RecordingAgentCoreClient,
} from "../core/recording-agent-core-client.js";
import { ScriptedLlmClient } from "../llm/scripted-llm-client.js";
import { runScenario } from "../runner.js";
import type { Observation } from "../runner.js";

function run(agentCore: RecordingAgentCoreClient): Promise<Observation> {
  return runScenario({
    id: "benign-auto-approve",
    customerId: "cust_evals_1",
    text: "Pay $120 to acme for invoice 42",
    idempotencyKey: "idem-benign-1",
    paymentMethodToken: "pm_configured",
    llm: new ScriptedLlmClient([
      paymentProposal({
        amount: 12000,
        currency: "USD",
        merchantId: "acme",
        reasoning: "Invoice 42 for acme.",
      }),
    ]),
    agentCore,
  });
}

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
