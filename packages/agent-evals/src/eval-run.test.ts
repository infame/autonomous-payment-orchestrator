import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { runSuite } from "./eval-run.js";
import { loadCorpus } from "./scenario.js";

const fixtures = new URL("./cli-fixtures/", import.meta.url);
const fixtureDir = (name: string): string =>
  fileURLToPath(new URL(`${name}/`, fixtures));

describe("runSuite", () => {
  it("returns one outcome per scenario with shape, order and durations", async () => {
    const dir = fixtureDir("clean");
    const scenarios = loadCorpus(dir);
    expect(scenarios.length).toBeGreaterThan(0);
    const startedAt = new Date("2026-01-02T03:04:05.006Z");
    const suite = await runSuite(scenarios, {
      mode: "hostile",
      corpusDir: dir,
      now: () => startedAt,
    });
    expect(suite.mode).toBe("hostile");
    expect(suite.corpusDir).toBe(dir);
    expect(suite.startedAt).toBe(startedAt);
    expect(suite.durationMs).toBeGreaterThanOrEqual(0);
    expect(suite.outcomes.map((o) => o.scenario.id)).toEqual(
      scenarios.map((s) => s.id),
    );
    for (const o of suite.outcomes) {
      expect(o.error).toBeNull();
      expect(o.observation).not.toBeNull();
      expect(o.invariants.length).toBe(8);
      expect(o.expectationFailures).toEqual([]);
      expect(o.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("captures a ScenarioStepError and still returns the outcome", async () => {
    const dir = fixtureDir("harness-error");
    const suite = await runSuite(loadCorpus(dir), {
      mode: "hostile",
      corpusDir: dir,
    });
    expect(suite.outcomes).toHaveLength(1);
    const [o] = suite.outcomes;
    expect(o?.error?.name).toBe("ScenarioStepError");
    expect(o?.error?.message).toContain("intent 5");
    expect(o?.observation).toBeNull();
    expect(o?.invariants).toEqual([]);
  });

  it("does not abort the rest of the suite after a failing scenario", async () => {
    const scenarios = loadCorpus(fixtureDir("harness-error")).concat(
      loadCorpus(fixtureDir("clean")),
    );
    const suite = await runSuite(scenarios, {
      mode: "hostile",
      corpusDir: "mixed",
    });
    expect(suite.outcomes.map((o) => o.error?.name ?? null)).toEqual([
      "ScenarioStepError",
      null,
    ]);
    expect(suite.outcomes[1]?.observation?.coreCalls.length).toBeGreaterThan(0);
  });
});
