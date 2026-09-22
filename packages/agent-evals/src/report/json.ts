/**
 * Outcomes + Metrics -> EvalReport. Redaction happens HERE, in the projection
 * from `Observation` to `ObservationEvidence`: the Observation is never
 * serialised wholesale, only whitelisted numbers, ids, statuses and paths
 * (see `types.ts`).
 */
import { isStartCall } from "../core/recording-agent-core-client.js";
import type {
  ScenarioOutcome,
  ScenarioSource,
  SuiteResult,
} from "../eval-run.js";
import type { Metrics } from "../metrics.js";
import { violationsOf } from "../oracles/index.js";
import type { Observation } from "../runner.js";
import type {
  EvalReport,
  EvidenceSource,
  ObservationEvidence,
  ReportedViolation,
  ScenarioReport,
} from "./types.js";

function sourceOf(
  corpusDir: string,
  scenarioId: string,
  source: ScenarioSource,
): EvidenceSource {
  return source.kind === "corpus"
    ? { kind: "corpus", file: `${corpusDir}/${scenarioId}.json` }
    : { kind: "fuzz", seed: source.seed, index: source.index };
}

function evidenceOf(
  source: EvidenceSource,
  o: Observation,
): ObservationEvidence {
  return {
    source,
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

function scenarioReport(
  corpusDir: string,
  out: ScenarioOutcome,
): ScenarioReport {
  const violations = violationsOf(out.invariants).length;
  return {
    id: out.scenario.id,
    category: out.scenario.category,
    source: sourceOf(corpusDir, out.scenario.id, out.source),
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
      sourceOf(suite.corpusDir, out.scenario.id, out.source),
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
    schemaVersion: 2,
    mode: suite.mode,
    startedAt: suite.startedAt.toISOString(),
    durationMs: suite.durationMs,
    corpus: {
      dir: suite.corpusDir,
      scenarios: suite.outcomes.filter((o) => o.source.kind === "corpus")
        .length,
    },
    fuzz:
      suite.fuzz === null
        ? null
        : {
            seed: suite.fuzz.seed,
            count: suite.fuzz.count,
            generator: suite.fuzz.generator,
            scenarios: metrics.byCategory.fuzz.scenarios,
            startCalls: metrics.byCategory.fuzz.startCalls,
            safetyViolations: metrics.byCategory.fuzz.safetyViolations,
            errors: metrics.byCategory.fuzz.errors,
          },
    gate: {
      name: "safety_violations",
      value: metrics.safetyViolations,
      pass: metrics.safetyViolations === 0,
    },
    metrics,
    scenarios: suite.outcomes.map((o) => scenarioReport(suite.corpusDir, o)),
    violations,
    baseline,
  };
}
