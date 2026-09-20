import { describe, expect, it } from "vitest";
import { clarifyProposal, paymentProposal } from "@apo/agent-orchestrator";
import { RecordingAgentCoreClient } from "./core/recording-agent-core-client.js";
import { ScriptedLlmClient } from "./llm/scripted-llm-client.js";
import { runScenario } from "./runner.js";
import type { ScenarioRunInput } from "./runner.js";

const TEXT = "Pay $120 to acme for invoice 42";

function benign(): ReturnType<typeof paymentProposal> {
  return paymentProposal({
    amount: 12000,
    currency: "USD",
    merchantId: "acme",
    reasoning: "Invoice 42 for acme.",
  });
}

function input(
  agentCore: RecordingAgentCoreClient,
  overrides: Partial<ScenarioRunInput> = {},
): ScenarioRunInput {
  return {
    id: "runner-test",
    customerId: "cust_evals_1",
    text: TEXT,
    llm: new ScriptedLlmClient([benign()]),
    agentCore,
    ...overrides,
  };
}

describe("runScenario", () => {
  it("slices coreCalls from the run's start when the recorder is reused, keeping absolute indexes", async () => {
    const agentCore = new RecordingAgentCoreClient();
    const obs1 = await runScenario(
      input(agentCore, { idempotencyKey: "idem-a" }),
    );
    const obs2 = await runScenario(
      input(agentCore, { idempotencyKey: "idem-b" }),
    );

    expect(obs1.coreCalls.length).toBeGreaterThan(0);
    expect(obs2.coreCalls.length).toBeGreaterThan(0);
    expect(obs2.coreCalls.every((c) => c.index >= obs1.coreCalls.length)).toBe(
      true,
    );
    expect(obs2.coreCalls[0]?.index).toBeGreaterThan(0);
    expect(obs2.coreCalls.length).toBeLessThan(agentCore.calls.length);
    const firstIndex = obs2.http[0]?.coreCallIndexes[0];
    expect(firstIndex).toBe(obs2.coreCalls[0]?.index);
    expect(firstIndex).not.toBe(0);
  });

  describe("clarificationAnswers", () => {
    it("does not record an answer whose clarify exchange was non-2xx", async () => {
      const obs = await runScenario(
        input(new RecordingAgentCoreClient(), {
          steps: [{ kind: "clarify", answer: "the vendor is acme" }],
        }),
      );
      const clarify = obs.http.find((h) => h.path.endsWith("/clarify"));
      expect(clarify?.status).toBe(422);
      expect(obs.clarificationAnswers).toEqual([]);
    });

    it("records the answer when the clarify exchange is 2xx", async () => {
      const obs = await runScenario(
        input(new RecordingAgentCoreClient(), {
          llm: new ScriptedLlmClient([
            clarifyProposal("Which vendor?"),
            benign(),
          ]),
          steps: [{ kind: "clarify", answer: "the vendor is acme" }],
        }),
      );
      const clarify = obs.http.find((h) => h.path.endsWith("/clarify"));
      expect(clarify?.status).toBe(200);
      expect(obs.clarificationAnswers).toEqual(["the vendor is acme"]);
    });
  });

  it("leaves finalView null when the final GET is non-2xx", async () => {
    const agentCore = new RecordingAgentCoreClient();
    const obs = await runScenario(
      input(agentCore, {
        idempotencyKey: "idem-boom",
        clock: () => {
          if (agentCore.calls.some((c) => c.method === "getRunStatus")) {
            throw new Error("clock boom");
          }
          return new Date();
        },
      }),
    );
    expect(obs.http.at(-1)?.status).toBe(500);
    expect(obs.finalView).toBeNull();
    expect(obs.views).toHaveLength(1);
  });
});
