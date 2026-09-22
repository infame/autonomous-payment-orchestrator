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
 * classes (ScenarioStepError, ScenarioLoadError, ScriptExhaustedError,
 * LiveBudgetExhaustedError), whose messages the harness authored. Any other
 * thrown value (a ZodError, a driver or HTTP-layer error) can embed scenario
 * text or a response body, and the report is a published artifact, so its
 * message is replaced by a fixed string (the `name` is kept for triage).
 *
 * `mode: "live"` (step 7) reuses every piece above unchanged: `RunSuiteOptions.llm`,
 * when set, is passed straight through to `runCorpusScenario` as
 * `CorpusRunOverrides.llm`, REPLACING each entry's own scripted/mock client —
 * see `scenario-run.ts`'s header. `livePasses` turns one set of entries into
 * `k` labelled copies (`SuiteEntry.run`, 0-indexed) so a live run can repeat
 * the whole corpus `k` times; `RunSuiteOptions.stopBefore`, consulted before
 * every entry, is how `eval:live`'s `BudgetedLlmClient` ceiling stops the
 * suite early (`SuiteResult.stoppedEarly`/`skipped`) without `runSuite` itself
 * knowing anything about budgets.
 */
import type { LlmClient } from "@apo/agent-orchestrator";
import { checkExpectations } from "./expectations.js";
import type { ExpectationFailure } from "./expectations.js";
import { checkInvariants } from "./oracles/index.js";
import type { InvariantResult } from "./oracles/index.js";
import { generateFuzzScenarios } from "./fuzz/generate.js";
import { LiveBudgetExhaustedError } from "./llm/budgeted-llm-client.js";
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
  /** Which live pass this entry belongs to, 0-indexed. Default 0 (every hostile entry, and pass 0 of a live run). */
  readonly run?: number;
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

/**
 * Repeats `entries` for `k` live passes, BLOCKED not round-robin: every entry
 * at run 0, then every entry at run 1, and so on. That ordering matters under
 * a call budget — a ceiling hit mid-run has covered the corpus's breadth once
 * before it starts spending on a second pass, rather than exhausting the
 * budget on a handful of scenarios repeated `k` times each.
 */
export function livePasses(
  entries: readonly SuiteEntry[],
  k: number,
): readonly SuiteEntry[] {
  const out: SuiteEntry[] = [];
  for (let run = 0; run < k; run += 1) {
    for (const entry of entries) {
      out.push({ ...entry, run });
    }
  }
  return out;
}

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
    err instanceof ScriptExhaustedError ||
    err instanceof LiveBudgetExhaustedError
  ) {
    return { name: err.name, message: err.message };
  }
  return { name: err.name, message: NON_HARNESS_ERROR_MESSAGE };
}

export interface ScenarioOutcome {
  readonly scenario: Scenario;
  readonly source: ScenarioSource;
  /** Which live pass produced this outcome, 0-indexed. Always 0 in hostile mode. */
  readonly run: number;
  /** null iff `error` is not null. */
  readonly observation: Observation | null;
  /** Empty iff `error` is not null. */
  readonly invariants: readonly InvariantResult[];
  readonly expectationFailures: readonly ExpectationFailure[];
  readonly error: HarnessError | null;
  readonly durationMs: number;
}

export interface SuiteResult {
  readonly mode: "hostile" | "live";
  readonly corpusDir: string;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly outcomes: readonly ScenarioOutcome[];
  /** Recorded so a report can name the seed and generator version; null when no fuzz layer ran. */
  readonly fuzz: FuzzRunInfo | null;
  /** True iff `stopBefore` ever tripped before every entry ran. */
  readonly stoppedEarly: boolean;
  /** Count of entries never run because `stopBefore` had already tripped. */
  readonly skipped: number;
}

export interface RunSuiteOptions {
  readonly mode: "hostile" | "live";
  readonly corpusDir: string;
  readonly now?: () => Date;
  readonly fuzz?: FuzzRunInfo;
  /** Live mode only: replaces every entry's own `llm` client outright. */
  readonly llm?: LlmClient;
  /** Consulted before each entry; true stops the suite (see `livePasses`'s header for why that leaves breadth-first coverage under a budget). */
  readonly stopBefore?: () => boolean;
}

async function runOne(
  { scenario, source, run }: SuiteEntry,
  llm: LlmClient | undefined,
): Promise<ScenarioOutcome> {
  const runIndex = run ?? 0;
  const t0 = performance.now();
  try {
    const observation = await runCorpusScenario(
      scenario,
      llm === undefined ? {} : { llm },
    );
    const invariants = checkInvariants(observation);
    return {
      scenario,
      source,
      run: runIndex,
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
      run: runIndex,
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
  let stoppedEarly = false;
  let skipped = 0;
  for (const entry of entries) {
    if (opts.stopBefore?.() === true) {
      stoppedEarly = true;
      skipped += 1;
      continue;
    }
    outcomes.push(await runOne(entry, opts.llm));
  }
  return {
    mode: opts.mode,
    corpusDir: opts.corpusDir,
    startedAt,
    durationMs: performance.now() - t0,
    outcomes,
    fuzz: opts.fuzz ?? null,
    stoppedEarly,
    skipped,
  };
}
