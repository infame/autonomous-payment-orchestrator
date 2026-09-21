/**
 * Suite runner: turns an array of scenarios into per-scenario outcomes by
 * reusing `runCorpusScenario` + `checkInvariants` + `checkExpectations`
 * verbatim. Scenarios run sequentially in the given order (loadCorpus order
 * for the corpus). A scenario whose run throws (a `ScenarioStepError`, or any
 * other Error) is captured into `outcome.error` and the suite CONTINUES: one
 * malformed scenario must not hide the safety verdict of the others.
 *
 * Takes an ARRAY, not a directory, so a later fuzz step can append generated
 * scenarios. `HarnessError.message` is harness-authored text only (step
 * errors); it never carries an HTTP response body.
 */
import { checkExpectations } from "./expectations.js";
import type { ExpectationFailure } from "./expectations.js";
import { checkInvariants } from "./oracles/index.js";
import type { InvariantResult } from "./oracles/index.js";
import type { Observation } from "./runner.js";
import type { Scenario } from "./scenario.js";
import { runCorpusScenario } from "./scenario-run.js";

export interface HarnessError {
  readonly name: string;
  /** Harness-authored only, never a response body. */
  readonly message: string;
}

export interface ScenarioOutcome {
  readonly scenario: Scenario;
  /** null iff `error` is not null. */
  readonly observation: Observation | null;
  /** Empty iff `error` is not null. */
  readonly invariants: readonly InvariantResult[];
  readonly expectationFailures: readonly ExpectationFailure[];
  readonly error: HarnessError | null;
  readonly durationMs: number;
}

export interface SuiteResult {
  readonly mode: "hostile";
  readonly corpusDir: string;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly outcomes: readonly ScenarioOutcome[];
}

export interface RunSuiteOptions {
  readonly mode: "hostile";
  readonly corpusDir: string;
  readonly now?: () => Date;
}

async function runOne(scenario: Scenario): Promise<ScenarioOutcome> {
  const t0 = performance.now();
  try {
    const observation = await runCorpusScenario(scenario);
    const invariants = checkInvariants(observation);
    return {
      scenario,
      observation,
      invariants,
      expectationFailures: checkExpectations(scenario, observation, invariants),
      error: null,
      durationMs: performance.now() - t0,
    };
  } catch (err) {
    const error: HarnessError =
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { name: "Error", message: "non-Error value thrown" };
    return {
      scenario,
      observation: null,
      invariants: [],
      expectationFailures: [],
      error,
      durationMs: performance.now() - t0,
    };
  }
}

export async function runSuite(
  scenarios: readonly Scenario[],
  opts: RunSuiteOptions,
): Promise<SuiteResult> {
  const now = opts.now ?? ((): Date => new Date());
  const startedAt = now();
  const t0 = performance.now();
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of scenarios) {
    outcomes.push(await runOne(scenario));
  }
  return {
    mode: opts.mode,
    corpusDir: opts.corpusDir,
    startedAt,
    durationMs: performance.now() - t0,
    outcomes,
  };
}
