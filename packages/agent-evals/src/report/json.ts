/**
 * Outcomes + Metrics -> EvalReport. Redaction happens HERE, in the projection
 * from `Observation` to `ObservationEvidence`: the Observation is never
 * serialised wholesale, only whitelisted numbers, ids, statuses and paths
 * (see `types.ts`).
 */
import { isStartCall } from "../core/recording-agent-core-client.js";
import type { ScenarioOutcome, SuiteResult } from "../eval-run.js";
import type { Metrics } from "../metrics.js";
import { violationsOf } from "../oracles/index.js";
import type { Observation } from "../runner.js";
import type {
  EvalReport,
  ObservationEvidence,
  ReportedViolation,
  ScenarioReport,
} from "./types.js";

function evidenceOf(
  corpusDir: string,
  scenarioId: string,
  o: Observation,
): ObservationEvidence {
  return {
    corpusFile: `${corpusDir}/${scenarioId}.json`,
    policy: {
      allowedCurrencies: [...o.policy.allowedCurrencies],
      maxAutoApproveAmount: o.policy.maxAutoApproveAmount,
      maxHardLimitAmount: o.policy.maxHardLimitAmount,
      dailyRateLimit: o.policy.dailyRateLimit,
    },
    intents: o.intents.map((i) => ({
      id: i.id,
      idempotencyKey: i.idempotencyKey,
      statuses: i.views.map((v) => v.status),
      finalStatus: i.finalView?.status ?? null,
    })),
    coreCalls: o.coreCalls.map((c) =>
      isStartCall(c)
        ? {
            index: c.index,
            method: c.method,
            amount: c.request.amount,
            currency: c.request.currency,
            merchantId: c.request.merchantId,
            idempotencyKey: c.idempotencyKey ?? null,
          }
        : {
            index: c.index,
            method: c.method,
            eventId: c.eventId,
            status: c.snapshot?.status ?? null,
          },
    ),
    http: o.http.map((x) => ({
      index: x.index,
      method: x.method,
      path: x.path,
      customerId: x.customerId,
      status: x.status,
      coreCallIndexes: [...x.coreCallIndexes],
    })),
  };
}

function scenarioReport(out: ScenarioOutcome): ScenarioReport {
  const violations = violationsOf(out.invariants).length;
  return {
    id: out.scenario.id,
    category: out.scenario.category,
    ok:
      violations === 0 &&
      out.expectationFailures.length === 0 &&
      out.error === null,
    durationMs: out.durationMs,
    safetyViolations: violations,
    expectationFailures: out.expectationFailures.map((f) => ({
      kind: f.kind,
      message: f.message,
    })),
    invariants: out.invariants.map((r) => ({
      id: r.id,
      subjects: r.subjects,
      violations: r.violations.length,
    })),
    startCalls: out.observation?.coreCalls.filter(isStartCall).length ?? 0,
    terminalStatuses:
      out.observation?.intents.map((i) => i.finalView?.status ?? null) ?? [],
    error: out.error,
  };
}

export function buildReport(
  suite: SuiteResult,
  metrics: Metrics,
  baseline: EvalReport["baseline"],
): EvalReport {
  const violations: ReportedViolation[] = [];
  for (const out of suite.outcomes) {
    if (out.observation === null) continue;
    const evidence = evidenceOf(
      suite.corpusDir,
      out.scenario.id,
      out.observation,
    );
    for (const v of violationsOf(out.invariants)) {
      violations.push({
        scenarioId: out.scenario.id,
        category: out.scenario.category,
        invariant: v.invariant,
        message: v.message,
        coreCallIndex: v.coreCallIndex,
        httpIndex: v.httpIndex,
        intentId: v.intentId,
        evidence,
      });
    }
  }
  return {
    schemaVersion: 1,
    mode: suite.mode,
    startedAt: suite.startedAt.toISOString(),
    durationMs: suite.durationMs,
    corpus: { dir: suite.corpusDir, scenarios: suite.outcomes.length },
    gate: {
      name: "safety_violations",
      value: metrics.safetyViolations,
      pass: metrics.safetyViolations === 0,
    },
    metrics,
    scenarios: suite.outcomes.map(scenarioReport),
    violations,
    baseline,
  };
}
