/**
 * Suite runner: turns an array of scenarios into per-scenario outcomes by
 * reusing `runCorpusScenario` + `checkInvariants` + `checkExpectations`
 * verbatim. Scenarios run sequentially in the given order (loadCorpus order
 * for the corpus). A scenario whose run throws (a `ScenarioStepError`, or any
 * other Error) is captured into `outcome.error` and the suite CONTINUES: one
 * malformed scenario must not hide the safety verdict of the others.
 *
 * Takes `SuiteEntry`s (a scenario plus where it came from), so corpus and
 * generated fuzz scenarios run through one pipeline; provenance lives on the
 * entry and the outcome, never on `Scenario` and never sniffed from an id.
 *
 * `HarnessError.message` passes through ONLY for the harness's own error
 * classes (ScenarioStepError, ScenarioLoadError, ScriptExhaustedError), whose
 * messages the harness authored. Any other thrown value (a ZodError, a driver
 * or HTTP-layer error) can embed scenario text or a response body, and the
 * report is a published artifact, so its message is replaced by a fixed string
 * (the `name` is kept for triage).
 */
import { checkExpectations } from "./expectations.js";
import type { ExpectationFailure } from "./expectations.js";
import { checkInvariants } from "./oracles/index.js";
import type { InvariantResult } from "./oracles/index.js";
import { generateFuzzScenarios } from "./fuzz/generate.js";
import { ScriptExhaustedError } from "./llm/scripted-llm-client.js";
import { ScenarioStepError } from "./runner.js";
import type { Observation } from "./runner.js";
import { ScenarioLoadError } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import { runCorpusScenario } from "./scenario-run.js";

/** Where a scenario came from; a fuzz case is replayable from (seed, index). */
export type ScenarioSource =
  | { readonly kind: "corpus" }
  | { readonly kind: "fuzz"; readonly seed: string; readonly index: number };

export interface SuiteEntry {
  readonly scenario: Scenario;
  readonly source: ScenarioSource;
}

export const corpusEntries = (
  scenarios: readonly Scenario[],
): readonly SuiteEntry[] =>
  scenarios.map((scenario) => ({ scenario, source: { kind: "corpus" } }));

export const fuzzEntries = (
  seed: string,
  count: number,
): readonly SuiteEntry[] =>
  generateFuzzScenarios(seed, count).map((scenario, index) => ({
    scenario,
    source: { kind: "fuzz", seed, index },
  }));

export interface FuzzRunInfo {
  readonly seed: string;
  readonly count: number;
  readonly generator: number;
}

export interface HarnessError {
  readonly name: string;
  /** Harness-authored only, never a response body (see header). */
  readonly message: string;
}

export const NON_HARNESS_ERROR_MESSAGE =
  "non-harness error; rerun locally to see it";

function harnessErrorOf(err: unknown): HarnessError {
  if (!(err instanceof Error)) {
    return { name: "Error", message: "non-Error value thrown" };
  }
  if (
    err instanceof ScenarioStepError ||
    err instanceof ScenarioLoadError ||
    err instanceof ScriptExhaustedError
  ) {
    return { name: err.name, message: err.message };
  }
  return { name: err.name, message: NON_HARNESS_ERROR_MESSAGE };
}

export interface ScenarioOutcome {
  readonly scenario: Scenario;
  readonly source: ScenarioSource;
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
  /** Recorded so a report can name the seed and generator version; null when no fuzz layer ran. */
  readonly fuzz: FuzzRunInfo | null;
}

export interface RunSuiteOptions {
  readonly mode: "hostile";
  readonly corpusDir: string;
  readonly now?: () => Date;
  readonly fuzz?: FuzzRunInfo;
}

async function runOne({
  scenario,
  source,
}: SuiteEntry): Promise<ScenarioOutcome> {
  const t0 = performance.now();
  try {
    const observation = await runCorpusScenario(scenario);
    const invariants = checkInvariants(observation);
    return {
      scenario,
      source,
      observation,
      invariants,
      expectationFailures: checkExpectations(scenario, observation, invariants),
      error: null,
      durationMs: performance.now() - t0,
    };
  } catch (err) {
    const error = harnessErrorOf(err);
    return {
      scenario,
      source,
      observation: null,
      invariants: [],
      expectationFailures: [],
      error,
      durationMs: performance.now() - t0,
    };
  }
}

export async function runSuite(
  entries: readonly SuiteEntry[],
  opts: RunSuiteOptions,
): Promise<SuiteResult> {
  const now = opts.now ?? ((): Date => new Date());
  const startedAt = now();
  const t0 = performance.now();
  const outcomes: ScenarioOutcome[] = [];
  for (const entry of entries) {
    outcomes.push(await runOne(entry));
  }
  return {
    mode: opts.mode,
    corpusDir: opts.corpusDir,
    startedAt,
    durationMs: performance.now() - t0,
    outcomes,
    fuzz: opts.fuzz ?? null,
  };
}
