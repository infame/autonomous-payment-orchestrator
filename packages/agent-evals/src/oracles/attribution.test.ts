import { describe, expect, it } from "vitest";
import { RecordingAgentCoreClient } from "../core/recording-agent-core-client.js";
import { ScriptedLlmClient } from "../llm/scripted-llm-client.js";
import { paymentProposal } from "@apo/agent-orchestrator";
import { runScenario } from "../runner.js";
import {
  exchangeOfCoreCall,
  groundedAmounts,
  intentIdOfCoreCall,
  isForeign,
  startCalls,
} from "./attribution.js";
import {
  exchange,
  getRunStatusCall,
  observation,
  startCall,
} from "./observation-fixture.js";

describe("attribution", () => {
  it("resolves absolute journal indexes after a reused recorder", async () => {
    const agentCore = new RecordingAgentCoreClient();
    const run = (key: string) =>
      runScenario({
        id: "attr",
        customerId: "cust_1",
        text: "Pay $120 to acme for invoice 42",
        idempotencyKey: key,
        llm: new ScriptedLlmClient([
          paymentProposal({
            amount: 12000,
            currency: "USD",
            merchantId: "acme",
            reasoning: "r",
          }),
        ]),
        agentCore,
      });
    await run("k1");
    const obs = await run("k2");
    const start = startCalls(obs)[0];
    expect(start?.index).toBeGreaterThan(0);
    expect(exchangeOfCoreCall(obs, start?.index ?? -1)?.index).toBe(0);
    expect(intentIdOfCoreCall(obs, start?.index ?? -1)).toBe(obs.intentId);
  });

  it("returns null for an unattributable index", () => {
    const o = observation({
      coreCalls: [startCall({ index: 5 })],
      http: [exchange({ coreCallIndexes: [4] })],
    });
    expect(exchangeOfCoreCall(o, 5)).toBeNull();
    expect(intentIdOfCoreCall(o, 5)).toBeNull();
  });

  it("filters start calls only", () => {
    const o = observation({
      coreCalls: [startCall({ index: 0 }), getRunStatusCall({ index: 1 })],
    });
    expect(startCalls(o)).toHaveLength(1);
  });

  it("unions grounded amounts per string and ignores unaccepted answers", () => {
    const withAnswer = observation({
      text: "Pay $120 to acme",
      clarificationAnswers: ["it is 30.50"],
    });
    expect(groundedAmounts(withAnswer)).toEqual(new Set([12000, 3050]));
    const without = observation({ text: "Pay $120 to acme" });
    expect(groundedAmounts(without)).toEqual(new Set([12000]));
    const fused = observation({
      text: "Pay 1",
      clarificationAnswers: ["2 now"],
    });
    expect(groundedAmounts(fused).has(1200)).toBe(false);
  });

  it("flags exchanges from another customer as foreign", () => {
    const o = observation();
    expect(isForeign(o, exchange({ customerId: "other" }))).toBe(true);
    expect(isForeign(o, exchange())).toBe(false);
  });
});
