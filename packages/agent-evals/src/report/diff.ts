/**
 * Pure previous x current -> ReportDiff.
 *
 * `EvalReport.scenarios` carries one entry per (scenario, run) pair — in a
 * live report with k>1 that DUPLICATES scenario ids (`ScenarioReport.run`
 * disambiguates within one report, but a diff compares by id across two
 * reports). `foldScenarios` collapses those duplicates back to one entry per
 * id with `ok` ANDed across every run, before either scenario is compared —
 * a scenario is "still ok" here only if every one of its k runs was.
 */
import type { InvariantId } from "../oracles/index.js";
import type { EvalReport } from "./types.js";

interface FoldedScenario {
  readonly id: string;
  readonly ok: boolean;
}

export interface ViolationKey {
  readonly scenarioId: string;
  readonly invariant: InvariantId;
}

export interface MetricDelta {
  readonly name: string;
  readonly before: number | null;
  readonly after: number | null;
}

export interface ReportDiff {
  readonly baselineFile: string;
  readonly baselineStartedAt: string;
  readonly metricDeltas: readonly MetricDelta[];
  readonly newViolations: readonly ViolationKey[];
  readonly fixedViolations: readonly ViolationKey[];
  readonly addedScenarios: readonly string[];
  readonly removedScenarios: readonly string[];
  readonly newlyFailingScenarios: readonly string[];
  readonly newlyPassingScenarios: readonly string[];
}

function metricValues(r: EvalReport): readonly [string, number | null][] {
  const m = r.metrics;
  const base: [string, number | null][] = [
    ["scenarios", m.scenarios],
    ["errors", m.errors],
    ["safetyViolations", m.safetyViolations],
    ["expectationFailures", m.expectationFailures],
    ["scenariosWithExpectationFailures", m.scenariosWithExpectationFailures],
    ["startCalls", m.startCalls],
    ["fuzzScenarios", m.byCategory.fuzz.scenarios],
    ["guardrailCatchRate", m.guardrailCatchRate?.value ?? null],
    ["falseRejectRate", m.falseRejectRate?.value ?? null],
    ["clarifyRate", m.clarifyRate?.value ?? null],
  ];
  if (r.live === null) return base;
  return [
    ...base,
    ["live.k", r.live.k],
    ["live.calls", r.live.calls],
    ["live.maxCalls", r.live.maxCalls],
    ["live.scenariosPlanned", r.live.scenariosPlanned],
    ["live.scenariosRun", r.live.scenariosRun],
    [
      "live.unsafeProposalRate",
      r.live.metrics.unsafeProposalRate?.value ?? null,
    ],
    ["live.gatedRate", r.live.metrics.gatedRate?.value ?? null],
    ["live.consistency", r.live.metrics.consistency?.value ?? null],
    ["live.passAtK", r.live.metrics.passAtK?.value ?? null],
  ];
}

function keysOf(r: EvalReport): Map<string, ViolationKey> {
  const out = new Map<string, ViolationKey>();
  for (const v of r.violations) {
    out.set(`${v.scenarioId}\u0000${v.invariant}`, {
      scenarioId: v.scenarioId,
      invariant: v.invariant,
    });
  }
  return out;
}

/** Collapses one entry per (scenario, run) down to one per scenario id, `ok` ANDed across every run — see file header. */
function foldScenarios(
  scenarios: EvalReport["scenarios"],
): Map<string, FoldedScenario> {
  const out = new Map<string, FoldedScenario>();
  for (const s of scenarios) {
    const existing = out.get(s.id);
    out.set(s.id, {
      id: s.id,
      ok: existing === undefined ? s.ok : existing.ok && s.ok,
    });
  }
  return out;
}

export function diffReports(
  previous: EvalReport,
  current: EvalReport,
): ReportDiff {
  const before = new Map(metricValues(previous));
  const prevKeys = keysOf(previous);
  const curKeys = keysOf(current);
  const prevScenarios = foldScenarios(previous.scenarios);
  const curScenarios = foldScenarios(current.scenarios);
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];
  for (const [id, cur] of curScenarios) {
    const prev = prevScenarios.get(id);
    if (prev === undefined) continue;
    if (prev.ok && !cur.ok) newlyFailing.push(id);
    if (!prev.ok && cur.ok) newlyPassing.push(id);
  }
  return {
    baselineFile: current.baseline?.file ?? "",
    baselineStartedAt: previous.startedAt,
    metricDeltas: metricValues(current).map(([name, after]) => ({
      name,
      before: before.get(name) ?? null,
      after,
    })),
    newViolations: [...curKeys]
      .filter(([k]) => !prevKeys.has(k))
      .map(([, v]) => v),
    fixedViolations: [...prevKeys]
      .filter(([k]) => !curKeys.has(k))
      .map(([, v]) => v),
    addedScenarios: [...curScenarios.keys()].filter(
      (id) => !prevScenarios.has(id),
    ),
    removedScenarios: [...prevScenarios.keys()].filter(
      (id) => !curScenarios.has(id),
    ),
    newlyFailingScenarios: newlyFailing,
    newlyPassingScenarios: newlyPassing,
  };
}
