/**
 * `eval:hostile` / `eval:live` CLI: loads a corpus, runs the suite, writes
 * the report pair and returns a process exit code. Pure of `process.*`:
 * everything the environment provides (clock, output, cwd, env) arrives
 * through `CliDeps`, and the code is RETURNED, never exited with, so it is
 * testable in-process.
 *
 * ## hostile
 *
 * Exit codes, in precedence order: 1 any safety violation; 3 any harness
 * error (corpus load failure, a scenario step error, an empty corpus, an
 * unknown flag, an unsupported mode); 2 expectation failures only; 0 clean.
 * A report is written for every run that got as far as running the suite
 * (0, 1, 2 and 3-by-step-error); usage and corpus-load errors write none.
 * A corrupt or mismatched baseline is never fatal: it degrades to "no diff"
 * with one stderr warning. The corpus size is deliberately not hard-coded;
 * it only has to be non-empty (generated fuzz cases do not count toward that).
 *
 * Fuzz: `--fuzz-seed`/`--fuzz-count` append generated scenarios to the corpus
 * run (default seed and 200 cases, `--fuzz-count 0` disables). A bad seed or
 * count is a usage error (exit 3, nothing written). `--dump-fuzz <dir>` writes
 * each generated scenario as `<dir>/<id>.json` for hand-promotion to the corpus.
 *
 * ## live (step 7)
 *
 * Replays the SAME corpus (optionally narrowed by `--category`/`--only`)
 * through a REAL `AnthropicLlmClient` (`live/llm-factory.ts`'s
 * `createLiveLlmClient`, built from `live-config.ts`'s `loadLiveConfig`),
 * `--k` interleaved passes (`livePasses`), under a hard call ceiling
 * (`BudgetedLlmClient`, `--max-calls`). The fuzz layer is not supported here:
 * any of `--fuzz-seed`, `--dump-fuzz`, or a `--fuzz-count` other than exactly
 * `"0"` together with `--mode live` is a hard usage error (exit 3) — live
 * mode spends real money per call, so a hostile-only flag is never silently
 * ignored there, not even a non-numeric `--fuzz-count` that would otherwise
 * parse as NaN and slip past a `> 0` check.
 * `deps.env` and `deps.createLiveLlm` exist ONLY for this mode: `env` feeds
 * `loadLiveConfig` (the one place a real key is ever read), and
 * `createLiveLlm` is a test seam (defaults to the real
 * `createLiveLlmClient`) — every test exercising live mode MUST inject a
 * fake here, never letting a real `AnthropicLlmClient` get constructed
 * un-faked in-process.
 *
 * Exit codes: 1 any safety violation; 3 ONLY a pre-run failure (bad usage, a
 * `ConfigError` — including a missing/blank `ANTHROPIC_API_KEY` — corpus load
 * failure, an empty scenario selection, or a report-write failure); 0
 * otherwise, INCLUDING expectation failures and per-scenario harness errors
 * (expected model nondeterminism/transport noise in live mode — visible in
 * the report's `live.failuresByCode` and `metrics.errors`, not in the exit
 * code). A ceiling hit mid-run does not change the exit code either: the
 * report is written with `live.stoppedEarly: true` and a Markdown PARTIAL
 * banner. `eval:live` never gates CI — see `.github/workflows/evals-live.yml`
 * (`workflow_dispatch` only, never `push`/`pull_request`), not this file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import {
  corpusEntries,
  fuzzEntries,
  livePasses,
  runSuite,
} from "./eval-run.js";
import {
  DEFAULT_FUZZ_COUNT,
  DEFAULT_FUZZ_SEED,
  FUZZ_GENERATOR_VERSION,
  FUZZ_SEED_PATTERN,
} from "./fuzz/generate.js";
import { computeLiveMetrics } from "./live/metrics.js";
import { createLiveLlmClient } from "./live/llm-factory.js";
import type { LiveLlm } from "./live/llm-factory.js";
import { ConfigError, loadLiveConfig } from "./live-config.js";
import type { LiveConfig } from "./live-config.js";
import { computeMetrics } from "./metrics.js";
import { diffReports } from "./report/diff.js";
import type { ReportDiff } from "./report/diff.js";
import { buildReport } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import type { EvalReport } from "./report/types.js";
import { findBaseline, readBaseline, writeReport } from "./report/write.js";
import { loadCorpus, ScenarioCategory } from "./scenario.js";
import type { Scenario } from "./scenario.js";

export interface CliDeps {
  readonly now: () => Date;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly cwd: string;
  /** Live mode only: the source `loadLiveConfig` parses. Never read directly by this file outside that one call. */
  readonly env: NodeJS.ProcessEnv;
  /** Test seam (live mode only). Defaults to the real `createLiveLlmClient` — every live-mode test MUST override this. */
  readonly createLiveLlm?: (cfg: LiveConfig, maxCalls: number) => LiveLlm;
}

export const EXIT = {
  ok: 0,
  safetyViolation: 1,
  expectationFailure: 2,
  harnessError: 3,
} as const;

const DEFAULT_CORPUS_DIR = fileURLToPath(new URL("./corpus/", import.meta.url));
const DEFAULT_OUT_DIR = fileURLToPath(new URL("../reports/", import.meta.url));

const MAX_FUZZ_COUNT = 10_000;

const USAGE = `Usage: eval:hostile [options]
       eval:live [options]

Common options:
  --mode <hostile|live>  Suite mode (default hostile)
  --corpus <dir>         Corpus directory (default: the packaged src/corpus)
  --out <dir>            Report directory (default: <package>/reports)
  --baseline <file>      Previous report to diff against (default: newest matching-mode report in --out)
  --no-baseline          Skip the diff
  --help                 Show this help

eval:hostile-only options:
  --fuzz-seed <seed>  Fuzz seed, [a-z0-9-] up to 32 chars (default ${DEFAULT_FUZZ_SEED})
  --fuzz-count <n>    Generated fuzz scenarios, 0 disables (default ${String(DEFAULT_FUZZ_COUNT)}, max ${String(MAX_FUZZ_COUNT)})
  --dump-fuzz <dir>   Write each generated scenario to <dir>/<id>.json

eval:live-only options (fuzz is not supported in live mode):
  --k <n>           Passes per scenario, overrides EVAL_LIVE_K (default 1)
  --max-calls <n>   Hard ceiling on real LLM calls, overrides MAX_LIVE_CALLS (default 100)
  --category <c>    Only run scenarios in this category
  --only <ids>      Only run these scenario ids, comma-separated

Exit codes (hostile): 0 clean, 1 safety violation, 2 expectation failure only,
3 harness error (bad usage, corpus load failure, scenario step error).
Exit codes (live): 0 clean OR expectation failures OR per-scenario harness
errors (expected model noise), 1 any safety violation, 3 pre-run failure only
(bad usage, ANTHROPIC_API_KEY/config error, corpus load failure, empty
selection, report-write failure). eval:live never gates CI.`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPositiveIntString(s: string): boolean {
  return /^\d+$/.test(s) && Number(s) > 0;
}

const CLI_OPTIONS = {
  mode: { type: "string" },
  corpus: { type: "string" },
  out: { type: "string" },
  baseline: { type: "string" },
  "no-baseline": { type: "boolean" },
  "fuzz-seed": { type: "string" },
  "fuzz-count": { type: "string" },
  "dump-fuzz": { type: "string" },
  k: { type: "string" },
  "max-calls": { type: "string" },
  category: { type: "string" },
  only: { type: "string" },
  help: { type: "boolean" },
} as const;

type ParsedArgs = ReturnType<
  typeof parseArgs<{
    readonly options: typeof CLI_OPTIONS;
    readonly strict: true;
    readonly allowPositionals: false;
  }>
>["values"];

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    deps.stderr(`agent-evals: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }

  if (values.help === true) {
    deps.stdout(USAGE);
    return EXIT.ok;
  }

  const mode = values.mode ?? "hostile";
  if (mode !== "hostile" && mode !== "live") {
    deps.stderr(`agent-evals: unsupported mode "${mode}"`);
    return EXIT.harnessError;
  }
  const prefix = mode === "live" ? "eval:live" : "eval:hostile";

  if (values["no-baseline"] === true && values.baseline !== undefined) {
    deps.stderr(`${prefix}: --baseline and --no-baseline are exclusive`);
    return EXIT.harnessError;
  }

  // Live mode spends real money per LLM call, so any hostile-only flag is a
  // hard usage error there, never a silent no-op — including a non-numeric
  // `--fuzz-count` (e.g. "abc" -> NaN -> `NaN > 0` is false, which used to
  // slip through unrejected).
  if (mode === "live") {
    if (values["fuzz-seed"] !== undefined) {
      deps.stderr(`${prefix}: --fuzz-seed is not supported in live mode`);
      return EXIT.harnessError;
    }
    if (values["dump-fuzz"] !== undefined) {
      deps.stderr(`${prefix}: --dump-fuzz is not supported in live mode`);
      return EXIT.harnessError;
    }
    const rawFuzzCount = values["fuzz-count"];
    if (rawFuzzCount !== undefined && rawFuzzCount !== "0") {
      deps.stderr(`${prefix}: --fuzz-count is not supported in live mode`);
      return EXIT.harnessError;
    }
  }

  const corpusDir =
    values.corpus === undefined
      ? DEFAULT_CORPUS_DIR
      : resolve(deps.cwd, values.corpus);
  const outDir =
    values.out === undefined ? DEFAULT_OUT_DIR : resolve(deps.cwd, values.out);

  return mode === "live"
    ? runLive(values, deps, corpusDir, outDir, prefix)
    : runHostile(values, deps, corpusDir, outDir, prefix);
}

async function runHostile(
  values: ParsedArgs,
  deps: CliDeps,
  corpusDir: string,
  outDir: string,
  prefix: string,
): Promise<number> {
  const fuzzSeed = values["fuzz-seed"] ?? DEFAULT_FUZZ_SEED;
  if (!FUZZ_SEED_PATTERN.test(fuzzSeed)) {
    deps.stderr(
      `${prefix}: --fuzz-seed must be lowercase letters, digits and single hyphens, at most 32 characters`,
    );
    return EXIT.harnessError;
  }
  const rawCount = values["fuzz-count"];
  const fuzzCount =
    rawCount === undefined ? DEFAULT_FUZZ_COUNT : Number(rawCount);
  if (
    (rawCount !== undefined && !/^\d{1,5}$/.test(rawCount)) ||
    fuzzCount > MAX_FUZZ_COUNT
  ) {
    deps.stderr(
      `${prefix}: --fuzz-count must be an integer from 0 to ${String(MAX_FUZZ_COUNT)}`,
    );
    return EXIT.harnessError;
  }

  let scenarios;
  try {
    scenarios = loadCorpus(corpusDir);
  } catch (err) {
    deps.stderr(`${prefix}: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }
  if (scenarios.length === 0) {
    deps.stderr(`${prefix}: corpus ${corpusDir} contains no scenarios`);
    return EXIT.harnessError;
  }

  const fuzz = fuzzEntries(fuzzSeed, fuzzCount);
  const dumpDir = values["dump-fuzz"];
  if (dumpDir !== undefined) {
    const target = resolve(deps.cwd, dumpDir);
    try {
      mkdirSync(target, { recursive: true });
      for (const { scenario } of fuzz) {
        writeFileSync(
          join(target, `${scenario.id}.json`),
          `${JSON.stringify(scenario, null, 2)}\n`,
        );
      }
    } catch (err) {
      deps.stderr(
        `${prefix}: cannot dump fuzz scenarios: ${errorMessage(err)}`,
      );
      return EXIT.harnessError;
    }
    deps.stdout(`fuzz: wrote ${String(fuzz.length)} scenarios to ${target}`);
  }

  // Discovered BEFORE writing, or the new report would be its own baseline.
  let previous: EvalReport | null = null;
  let baselineFile: string | null = null;
  if (values["no-baseline"] !== true) {
    baselineFile =
      values.baseline === undefined
        ? findBaseline(outDir, "hostile")
        : resolve(deps.cwd, values.baseline);
    if (baselineFile !== null) {
      previous = readBaseline(baselineFile);
      if (previous === null) {
        deps.stderr(
          `${prefix}: warning: baseline ${baselineFile} is unreadable or has a different schema version; skipping the diff`,
        );
      }
    }
  }

  const suite = await runSuite([...corpusEntries(scenarios), ...fuzz], {
    mode: "hostile",
    corpusDir,
    now: deps.now,
    ...(fuzzCount === 0
      ? {}
      : {
          fuzz: {
            seed: fuzzSeed,
            count: fuzzCount,
            generator: FUZZ_GENERATOR_VERSION,
          },
        }),
  });
  const metrics = computeMetrics(suite.outcomes, "hostile");
  const report = buildReport(
    suite,
    metrics,
    previous !== null && baselineFile !== null
      ? { file: baselineFile, startedAt: previous.startedAt }
      : null,
    null,
    deps.cwd,
  );
  const diff: ReportDiff | null =
    previous === null ? null : diffReports(previous, report);

  try {
    const written = writeReport(
      report,
      renderMarkdown(report, diff),
      outDir,
      suite.startedAt,
    );
    deps.stdout(`report: ${written.jsonPath}`);
    deps.stdout(`report: ${written.mdPath}`);
  } catch (err) {
    deps.stderr(`${prefix}: cannot write report: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }

  deps.stdout(
    `agent-evals hostile: ${String(report.corpus.scenarios)} corpus + ${String(fuzzCount)} fuzz scenarios, safety violations ${String(metrics.safetyViolations)} (${report.gate.pass ? "PASS" : "FAIL"}), expectation failures ${String(metrics.expectationFailures)}, harness errors ${String(metrics.errors)}`,
  );

  if (metrics.safetyViolations > 0) return EXIT.safetyViolation;
  if (metrics.errors > 0) return EXIT.harnessError;
  if (metrics.expectationFailures > 0) return EXIT.expectationFailure;
  return EXIT.ok;
}

function filterScenarios(
  scenarios: readonly Scenario[],
  category: string | undefined,
  only: string | undefined,
): readonly Scenario[] {
  let out = scenarios;
  if (category !== undefined) {
    out = out.filter((s) => s.category === category);
  }
  if (only !== undefined) {
    const ids = new Set(
      only
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    );
    out = out.filter((s) => ids.has(s.id));
  }
  return out;
}

async function runLive(
  values: ParsedArgs,
  deps: CliDeps,
  corpusDir: string,
  outDir: string,
  prefix: string,
): Promise<number> {
  if (
    values.category !== undefined &&
    !(ScenarioCategory.options as readonly string[]).includes(values.category)
  ) {
    deps.stderr(
      `${prefix}: --category must be one of ${ScenarioCategory.options.join(", ")}`,
    );
    return EXIT.harnessError;
  }

  const rawK = values.k;
  if (rawK !== undefined && !isPositiveIntString(rawK)) {
    deps.stderr(`${prefix}: --k must be a positive integer`);
    return EXIT.harnessError;
  }
  const rawMaxCalls = values["max-calls"];
  if (rawMaxCalls !== undefined && !isPositiveIntString(rawMaxCalls)) {
    deps.stderr(`${prefix}: --max-calls must be a positive integer`);
    return EXIT.harnessError;
  }

  let cfg: LiveConfig;
  try {
    cfg = loadLiveConfig(deps.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      deps.stderr(`${prefix}: ${err.message}`);
      return EXIT.harnessError;
    }
    throw err;
  }

  const k = rawK === undefined ? cfg.EVAL_LIVE_K : Number(rawK);
  const maxCalls =
    rawMaxCalls === undefined ? cfg.MAX_LIVE_CALLS : Number(rawMaxCalls);

  let scenarios;
  try {
    scenarios = loadCorpus(corpusDir);
  } catch (err) {
    deps.stderr(`${prefix}: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }
  const selected = filterScenarios(scenarios, values.category, values.only);
  if (selected.length === 0) {
    deps.stderr(`${prefix}: no scenarios selected from ${corpusDir}`);
    return EXIT.harnessError;
  }

  // Discovered BEFORE writing, or the new report would be its own baseline.
  let previous: EvalReport | null = null;
  let baselineFile: string | null = null;
  if (values["no-baseline"] !== true) {
    baselineFile =
      values.baseline === undefined
        ? findBaseline(outDir, "live")
        : resolve(deps.cwd, values.baseline);
    if (baselineFile !== null) {
      previous = readBaseline(baselineFile);
      if (previous === null) {
        deps.stderr(
          `${prefix}: warning: baseline ${baselineFile} is unreadable or has a different schema version; skipping the diff`,
        );
      }
    }
  }

  const entries = livePasses(corpusEntries(selected), k);
  const live = (deps.createLiveLlm ?? createLiveLlmClient)(cfg, maxCalls);

  const suite = await runSuite(entries, {
    mode: "live",
    corpusDir,
    now: deps.now,
    llm: live.client,
    stopBefore: () => live.budget.exhausted,
  });
  const metrics = computeMetrics(suite.outcomes, "live");
  const liveMetrics = computeLiveMetrics(suite.outcomes, k);
  const report = buildReport(
    suite,
    metrics,
    previous !== null && baselineFile !== null
      ? { file: baselineFile, startedAt: previous.startedAt }
      : null,
    {
      model: cfg.ANTHROPIC_MODEL,
      k,
      maxCalls,
      calls: live.budget.calls,
      failuresByCode: live.budget.failuresByCode,
      stoppedEarly: suite.stoppedEarly,
      scenariosPlanned: entries.length,
      scenariosRun: suite.outcomes.length,
      metrics: liveMetrics,
    },
    deps.cwd,
  );
  const diff: ReportDiff | null =
    previous === null ? null : diffReports(previous, report);

  try {
    const written = writeReport(
      report,
      renderMarkdown(report, diff),
      outDir,
      suite.startedAt,
    );
    deps.stdout(`report: ${written.jsonPath}`);
    deps.stdout(`report: ${written.mdPath}`);
  } catch (err) {
    deps.stderr(`${prefix}: cannot write report: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }

  deps.stdout(
    `agent-evals live: model ${report.live?.model ?? "?"}, k ${String(k)}, ${String(suite.outcomes.length)} of ${String(entries.length)} runs (${live.budget.calls}/${String(maxCalls)} calls)${suite.stoppedEarly ? " PARTIAL" : ""}, safety violations ${String(metrics.safetyViolations)} (${report.gate.pass ? "PASS" : "FAIL"})`,
  );

  return metrics.safetyViolations > 0 ? EXIT.safetyViolation : EXIT.ok;
}
