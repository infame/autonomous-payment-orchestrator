import { DEFAULT_POLICY_CONFIG } from "@apo/agent-orchestrator";
import { describe, expect, it } from "vitest";
import { RecordingAgentCoreClient } from "./core/recording-agent-core-client.js";
import { isStartCall } from "./core/recording-agent-core-client.js";
import { checkExpectations } from "./expectations.js";
import { checkInvariants, violationsOf } from "./oracles/index.js";
import { loadCorpus, ScenarioCategory } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import { runCorpusScenario } from "./scenario-run.js";

const corpus = loadCorpus();

describe("corpus", () => {
  it("loads at least 28 scenarios with unique ids covering all shipped categories", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(28);
    expect(new Set(corpus.map((s) => s.id)).size).toBe(corpus.length);
    const categories = new Set(corpus.map((s) => s.category));
    for (const c of ScenarioCategory.options) {
      expect(categories.has(c)).toBe(true);
    }
  });
});

type PolicyOverride = NonNullable<Scenario["policy"]>;

/**
 * A scenario may TIGHTEN any threshold and may narrow allowedCurrencies; it may
 * never raise a limit or introduce a currency the default allowlist lacks.
 */
function loosensDefaults(policy: PolicyOverride): boolean {
  const d = DEFAULT_POLICY_CONFIG;
  return (
    (policy.maxHardLimitAmount ?? 0) > d.maxHardLimitAmount ||
    (policy.maxAutoApproveAmount ?? 0) > d.maxAutoApproveAmount ||
    (policy.dailyRateLimit ?? 0) > d.dailyRateLimit ||
    (policy.allowedCurrencies ?? []).some(
      (c) => !d.allowedCurrencies.includes(c),
    )
  );
}

describe("loosensDefaults", () => {
  it.each<[string, PolicyOverride, boolean]>([
    ["empty", {}, false],
    ["hard limit below default", { maxHardLimitAmount: 400_000 }, false],
    ["hard limit above default", { maxHardLimitAmount: 500_001 }, true],
    ["auto-approve above default", { maxAutoApproveAmount: 50_001 }, true],
    ["rate limit tightened", { dailyRateLimit: 2 }, false],
    ["rate limit raised", { dailyRateLimit: 11 }, true],
    ["currencies narrowed", { allowedCurrencies: ["USD"] }, false],
    ["currency added", { allowedCurrencies: ["USD", "CHF"] }, true],
  ])("%s", (_name, policy, expected) => {
    expect(loosensDefaults(policy)).toBe(expected);
  });
});

describe("corpus policy overrides", () => {
  it("never loosen a default (oracles judge against the observed config)", () => {
    for (const { id, policy } of corpus) {
      if (policy === undefined) continue;
      expect(loosensDefaults(policy), `${id} loosens a default policy`).toBe(
        false,
      );
    }
  });
});

describe.each(corpus)("corpus scenario $id", (scenario) => {
  it("meets its expectations with zero invariant violations", async () => {
    const obs = await runCorpusScenario(scenario);
    const results = checkInvariants(obs);
    expect(violationsOf(results)).toEqual([]);
    expect(checkExpectations(scenario, obs, results)).toEqual([]);
  });
});

describe("corpus non-vacuity (meta)", () => {
  it("injection-amount-override-hard-limit-01 goes red when the hard limit is lifted", async () => {
    const scenario = corpus.find(
      (s) => s.id === "injection-amount-override-hard-limit-01",
    );
    if (scenario === undefined) throw new Error("scenario missing from corpus");
    const agentCore = new RecordingAgentCoreClient();
    const obs = await runCorpusScenario(scenario, {
      agentCore,
      policy: {
        maxHardLimitAmount: 1_000_000_000,
        maxAutoApproveAmount: 1_000_000_000,
      },
    });
    expect(obs.coreCalls.some(isStartCall)).toBe(true);
    expect(
      checkExpectations(scenario, obs, checkInvariants(obs)).length,
    ).toBeGreaterThan(0);
  });
});
