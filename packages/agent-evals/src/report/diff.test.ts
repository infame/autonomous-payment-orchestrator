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

  it("folds duplicate scenario ids (k>1 in a live report), ANDing ok across every run", async () => {
    const good = await reportOf("clean");
    const [s] = good.scenarios;
    if (s === undefined) throw new Error("no scenario");
    // Two runs of the same scenario id: one ok, one not -> folded ok is false.
    const mixed: EvalReport = {
      ...good,
      baseline,
      scenarios: [
        { ...s, run: 0, ok: true },
        { ...s, run: 1, ok: false },
      ],
    };
    const bothOk: EvalReport = {
      ...good,
      scenarios: [
        { ...s, run: 0, ok: true },
        { ...s, run: 1, ok: true },
      ],
    };
    const diff = diffReports(bothOk, mixed);
    expect(diff.newlyFailingScenarios).toEqual([s.id]);
    expect(diff.addedScenarios).toEqual([]);
    expect(diff.removedScenarios).toEqual([]);
  });

  it("appends live.* metric deltas only when the current report carries a live block", async () => {
    const previous = await reportOf("clean");
    const live: EvalReport["live"] = {
      model: "claude-sonnet-5",
      k: 2,
      maxCalls: 50,
      calls: 40,
      failuresByCode: {},
      stoppedEarly: false,
      scenariosPlanned: 2,
      scenariosRun: 2,
      metrics: {
        unsafeProposalRate: { numerator: 1, denominator: 4, value: 0.25 },
        gatedRate: null,
        consistency: { numerator: 2, denominator: 4, value: 0.5 },
        passAtK: { numerator: 1, denominator: 2, value: 0.5 },
      },
    };
    const current: EvalReport = { ...previous, baseline, live };
    const diff = diffReports(previous, current);
    const byName = new Map(diff.metricDeltas.map((d) => [d.name, d]));
    expect(byName.get("live.calls")).toEqual({
      name: "live.calls",
      before: null,
      after: 40,
    });
    expect(byName.get("live.unsafeProposalRate")).toEqual({
      name: "live.unsafeProposalRate",
      before: null,
      after: 0.25,
    });
    expect(byName.get("live.gatedRate")).toEqual({
      name: "live.gatedRate",
      before: null,
      after: null,
    });
    // No live block on the hostile-vs-hostile diff.
    const hostileDiff = diffReports(previous, { ...previous, baseline });
    expect(
      hostileDiff.metricDeltas.some((d) => d.name.startsWith("live.")),
    ).toBe(false);
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
