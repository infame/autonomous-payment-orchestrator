import { describe, expect, it } from "vitest";
import { clarifyProposal } from "@apo/agent-orchestrator";
import type { AgentProposal, LlmClient } from "@apo/agent-orchestrator";
import { isStartCall } from "./core/recording-agent-core-client.js";
import { parseScenario } from "./scenario.js";
import { runCorpusScenario } from "./scenario-run.js";

/** In-repo fake only; never a real network call or ANTHROPIC_API_KEY. */
class StubLlmClient implements LlmClient {
  readonly name = "stub";
  callCount = 0;

  constructor(private readonly proposal: AgentProposal) {}

  reason(): Promise<AgentProposal> {
    this.callCount += 1;
    return Promise.resolve(this.proposal);
  }
}

const pay = (amount: number) => ({
  kind: "propose_payment",
  amount,
  currency: "USD",
  merchantId: "acme",
  reasoning: "r",
});

function scenario(overrides: Record<string, unknown>) {
  return parseScenario(
    "f.json",
    JSON.stringify({
      id: "unit-01",
      category: "benign",
      description: "d",
      customerId: "cust_unit",
      text: "Pay $600 to acme for the renewal",
      expect: { terminal: ["proposed"], coreCalls: { min: 0, max: 9 } },
      ...overrides,
    }),
  );
}

describe("runCorpusScenario", () => {
  it("passes a submit step's idempotencyKey and a step's intent index through", async () => {
    const obs = await runCorpusScenario(
      scenario({
        idempotencyKey: "k1",
        llm: { mode: "script", proposals: [pay(60000), pay(60000)] },
        steps: [
          { kind: "submit", idempotencyKey: "k2" },
          { kind: "approve", intent: 0 },
        ],
      }),
    );
    expect(obs.intents.map((i) => i.idempotencyKey)).toEqual(["k1", "k2"]);
    expect(obs.intents[0]?.finalView?.status).toBe("executing");
    expect(obs.intents[1]?.finalView?.status).toBe("needs_approval");
  });

  it("passes mock config (outcome, currency, merchant) to MockLlmClient", async () => {
    const obs = await runCorpusScenario(
      scenario({
        text: "Pay $120 to acme for invoice 42",
        idempotencyKey: "k1",
        llm: {
          mode: "mock",
          config: {
            defaultOutcome: { kind: "payment", selector: "max" },
            defaultCurrency: "EUR",
            defaultMerchantId: "acme",
          },
        },
      }),
    );
    const start = obs.coreCalls.find(isStartCall);
    expect(start?.request.currency).toBe("EUR");
    expect(start?.request.merchantId).toBe("acme");
  });

  it("overrides.llm takes precedence over the scenario's own script/mock client", async () => {
    const stub = new StubLlmClient(clarifyProposal("overridden question"));
    const obs = await runCorpusScenario(
      scenario({
        llm: { mode: "script", proposals: [pay(60000)] },
      }),
      { llm: stub },
    );
    expect(stub.callCount).toBe(1);
    expect(obs.intents[0]?.finalView?.status).toBe("needs_clarification");
  });
});
