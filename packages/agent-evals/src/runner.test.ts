import { describe, expect, it } from "vitest";
import { clarifyProposal, paymentProposal } from "@apo/agent-orchestrator";
import { RecordingAgentCoreClient } from "./core/recording-agent-core-client.js";
import { ScriptedLlmClient } from "./llm/scripted-llm-client.js";
import { runScenario, ScenarioStepError } from "./runner.js";
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

describe("runScenario: multi-intent and foreign callers", () => {
  it("records an `as` exchange with the foreign customerId, 404 and no core calls", async () => {
    const obs = await runScenario(
      input(new RecordingAgentCoreClient(), {
        steps: [{ kind: "get", as: "cust_foreign" }],
      }),
    );
    const foreign = obs.http.find((h) => h.customerId === "cust_foreign");
    expect(foreign?.status).toBe(404);
    expect(foreign?.coreCallIndexes).toEqual([]);
    expect(foreign?.intentId).toBe(obs.intentId);
    expect(obs.intents[0]?.views).toHaveLength(2);
    expect(obs.views).toHaveLength(2);
  });

  it("tracks two submits with different keys as two intents, each with its own finalView", async () => {
    const obs = await runScenario(
      input(new RecordingAgentCoreClient(), {
        idempotencyKey: "idem-1",
        llm: new ScriptedLlmClient([benign(), benign()]),
        steps: [{ kind: "submit", idempotencyKey: "idem-2" }],
      }),
    );
    expect(obs.intents).toHaveLength(2);
    const [a, b] = obs.intents;
    expect(a?.id).not.toBe(b?.id);
    expect(a?.finalView?.id).toBe(a?.id);
    expect(b?.finalView?.id).toBe(b?.id);
    expect(a?.idempotencyKey).toBe("idem-1");
    expect(b?.idempotencyKey).toBe("idem-2");
    for (const i of obs.intents) {
      expect(obs.http[i.submitExchangeIndex]?.intentId).toBe(i.id);
    }
    expect(obs.http.at(-1)?.intentId).toBe(b?.id);
    expect(obs.intentId).toBe(a?.id);
    expect(obs.finalView).toBe(a?.finalView);
  });

  it("dedupes a same-key resubmit into one intent with two views and one start call", async () => {
    const obs = await runScenario(
      input(new RecordingAgentCoreClient(), {
        idempotencyKey: "idem-same",
        llm: new ScriptedLlmClient([benign(), benign()]),
        steps: [{ kind: "submit", idempotencyKey: "idem-same" }],
      }),
    );
    expect(obs.intents).toHaveLength(1);
    expect(obs.intents[0]?.views.length).toBeGreaterThanOrEqual(3);
    expect(
      obs.coreCalls.filter((c) => c.method === "startPaymentWorkflow"),
    ).toHaveLength(1);
  });
});

describe("runScenario: step selector", () => {
  it("throws ScenarioStepError for an out-of-range intent index", async () => {
    await expect(
      runScenario(
        input(new RecordingAgentCoreClient(), {
          steps: [{ kind: "get", intent: 3 }],
        }),
      ),
    ).rejects.toThrow(ScenarioStepError);
  });

  it("throws ScenarioStepError for a step after a submit that returned no view", async () => {
    await expect(
      runScenario(
        input(new RecordingAgentCoreClient(), {
          text: " ",
          steps: [{ kind: "get" }],
        }),
      ),
    ).rejects.toThrow(ScenarioStepError);
  });

  it("throws the no-view error (not the range error) for a step after a failed submit step", async () => {
    await expect(
      runScenario(
        input(new RecordingAgentCoreClient(), {
          steps: [{ kind: "submit", idempotencyKey: "k2" }, { kind: "get" }],
        }),
      ),
    ).rejects.toThrow(/follows a submit that returned no intent view/);
  });

  it("addresses intents by Observation.intents index, not by submit order", async () => {
    const big = () =>
      paymentProposal({
        amount: 60000,
        currency: "USD",
        merchantId: "acme",
        reasoning: "Invoice 42 for acme.",
      });
    const obs = await runScenario(
      input(new RecordingAgentCoreClient(), {
        text: "Pay $600 to acme for invoice 42",
        idempotencyKey: "idem-1",
        llm: new ScriptedLlmClient([big(), big()]),
        steps: [
          { kind: "submit", idempotencyKey: "idem-2" },
          { kind: "approve", intent: 0 },
        ],
      }),
    );
    const [a, b] = obs.intents;
    const approve = obs.http.find((h) => h.path.endsWith("/approve"));
    expect(approve?.path).toBe(`/intents/${a?.id ?? ""}/approve`);
    expect(a?.finalView?.status).toBe("executing");
    expect(b?.finalView?.status).toBe("needs_approval");
  });

  it("a foreign `as` clarify is 404 and records no answer", async () => {
    const obs = await runScenario(
      input(new RecordingAgentCoreClient(), {
        llm: new ScriptedLlmClient([
          clarifyProposal("Which vendor?"),
          benign(),
        ]),
        steps: [
          { kind: "clarify", answer: "the vendor is acme", as: "cust_foreign" },
        ],
      }),
    );
    const clarify = obs.http.find((h) => h.path.endsWith("/clarify"));
    expect(clarify?.customerId).toBe("cust_foreign");
    expect(clarify?.status).toBe(404);
    expect(obs.clarificationAnswers).toEqual([]);
  });
});
