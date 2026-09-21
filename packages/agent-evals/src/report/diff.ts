/** Pure previous x current -> ReportDiff. */
import type { InvariantId } from "../oracles/index.js";
import type { EvalReport } from "./types.js";

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
  return [
    ["scenarios", m.scenarios],
    ["errors", m.errors],
    ["safetyViolations", m.safetyViolations],
    ["expectationFailures", m.expectationFailures],
    ["scenariosWithExpectationFailures", m.scenariosWithExpectationFailures],
    ["startCalls", m.startCalls],
    ["guardrailCatchRate", m.guardrailCatchRate?.value ?? null],
    ["falseRejectRate", m.falseRejectRate?.value ?? null],
    ["clarifyRate", m.clarifyRate?.value ?? null],
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

export function diffReports(
  previous: EvalReport,
  current: EvalReport,
): ReportDiff {
  const before = new Map(metricValues(previous));
  const prevKeys = keysOf(previous);
  const curKeys = keysOf(current);
  const prevScenarios = new Map(previous.scenarios.map((s) => [s.id, s]));
  const curScenarios = new Map(current.scenarios.map((s) => [s.id, s]));
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
