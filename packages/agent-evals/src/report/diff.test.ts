import { describe, expect, it } from "vitest";
import { diffReports } from "./diff.js";
import { reportOf } from "./test-support.js";
import type { EvalReport } from "./types.js";

const baseline: EvalReport["baseline"] = {
  file: "prev.json",
  startedAt: "2026-01-01T00:00:00.000Z",
};

describe("diffReports", () => {
  it("reports a new violation, newly failing scenario and metric deltas", async () => {
    const previous = await reportOf("clean");
    const violating = await reportOf("violating", baseline);
    const diff = diffReports(previous, violating);
    expect(diff.baselineFile).toBe("prev.json");
    expect(diff.newViolations).toEqual([
      { scenarioId: "cli-fixture-violating", invariant: "I8" },
    ]);
    expect(diff.fixedViolations).toEqual([]);
    expect(diff.addedScenarios).toEqual(["cli-fixture-violating"]);
    expect(diff.removedScenarios).toEqual(["cli-fixture-clean"]);
    const safety = diff.metricDeltas.find((d) => d.name === "safetyViolations");
    expect(safety).toEqual({ name: "safetyViolations", before: 0, after: 1 });
  });

  it("reports fixed violations and null to number rate deltas", async () => {
    const previous = await reportOf("violating");
    const clean = await reportOf("clean", baseline);
    const diff = diffReports(previous, clean);
    expect(diff.fixedViolations).toEqual([
      { scenarioId: "cli-fixture-violating", invariant: "I8" },
    ]);
    expect(diff.newViolations).toEqual([]);
    const fr = diff.metricDeltas.find((d) => d.name === "falseRejectRate");
    expect(fr).toEqual({ name: "falseRejectRate", before: null, after: 0 });
  });

  it("tracks newly failing and newly passing scenarios of the same id", async () => {
    const good = await reportOf("clean");
    const [s] = good.scenarios;
    if (s === undefined) throw new Error("no scenario");
    const failing: EvalReport = {
      ...good,
      baseline,
      scenarios: [{ ...s, ok: false }],
    };
    expect(diffReports(good, failing).newlyFailingScenarios).toEqual([s.id]);
    expect(diffReports(good, failing).newlyPassingScenarios).toEqual([]);
    const back = diffReports(failing, { ...good, baseline });
    expect(back.newlyPassingScenarios).toEqual([s.id]);
    expect(back.newlyFailingScenarios).toEqual([]);
  });

  it("carries a fuzzScenarios delta row", async () => {
    const previous = await reportOf("clean");
    const current: EvalReport = {
      ...previous,
      baseline,
      metrics: {
        ...previous.metrics,
        byCategory: {
          ...previous.metrics.byCategory,
          fuzz: { ...previous.metrics.byCategory.fuzz, scenarios: 200 },
        },
      },
    };
    const row = diffReports(previous, current).metricDeltas.find(
      (d) => d.name === "fuzzScenarios",
    );
    expect(row).toEqual({ name: "fuzzScenarios", before: 0, after: 200 });
  });
});
