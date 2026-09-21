/**
 * `eval:hostile` CLI: loads a corpus, runs the suite, writes the report pair
 * and returns a process exit code. Pure of `process.*`: everything the
 * environment provides (clock, output, cwd) arrives through `CliDeps`, and
 * the code is RETURNED, never exited with, so it is testable in-process.
 *
 * Exit codes, in precedence order: 1 any safety violation; 3 any harness
 * error (corpus load failure, a scenario step error, an empty corpus, an
 * unknown flag, an unsupported mode); 2 expectation failures only; 0 clean.
 * A report is written for every run that got as far as running the suite
 * (0, 1, 2 and 3-by-step-error); usage and corpus-load errors write none.
 * A corrupt or mismatched baseline is never fatal: it degrades to "no diff"
 * with one stderr warning. The corpus size is deliberately not hard-coded;
 * it only has to be non-empty.
 */
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { runSuite } from "./eval-run.js";
import { computeMetrics } from "./metrics.js";
import { diffReports } from "./report/diff.js";
import type { ReportDiff } from "./report/diff.js";
import { buildReport } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import type { EvalReport } from "./report/types.js";
import { findBaseline, readBaseline, writeReport } from "./report/write.js";
import { loadCorpus } from "./scenario.js";

export interface CliDeps {
  readonly now: () => Date;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly cwd: string;
}

export const EXIT = {
  ok: 0,
  safetyViolation: 1,
  expectationFailure: 2,
  harnessError: 3,
} as const;

const DEFAULT_CORPUS_DIR = fileURLToPath(new URL("./corpus/", import.meta.url));
const DEFAULT_OUT_DIR = fileURLToPath(new URL("../reports/", import.meta.url));

const USAGE = `Usage: eval:hostile [options]

Options:
  --mode <hostile>    Suite mode (default hostile; live arrives with step 7)
  --corpus <dir>      Corpus directory (default: the packaged src/corpus)
  --out <dir>         Report directory (default: <package>/reports)
  --baseline <file>   Previous report to diff against (default: newest in --out)
  --no-baseline       Skip the diff
  --help              Show this help

Exit codes: 0 clean, 1 safety violation, 2 expectation failure only,
3 harness error (bad usage, corpus load failure, scenario step error).`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        mode: { type: "string" },
        corpus: { type: "string" },
        out: { type: "string" },
        baseline: { type: "string" },
        "no-baseline": { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    deps.stderr(`eval:hostile: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }

  if (values.help === true) {
    deps.stdout(USAGE);
    return EXIT.ok;
  }

  const mode = values.mode ?? "hostile";
  if (mode === "live") {
    deps.stderr("eval:hostile: live mode is not implemented until step 7");
    return EXIT.harnessError;
  }
  if (mode !== "hostile") {
    deps.stderr(`eval:hostile: unsupported mode "${mode}"`);
    return EXIT.harnessError;
  }
  if (values["no-baseline"] === true && values.baseline !== undefined) {
    deps.stderr("eval:hostile: --baseline and --no-baseline are exclusive");
    return EXIT.harnessError;
  }

  const corpusDir =
    values.corpus === undefined
      ? DEFAULT_CORPUS_DIR
      : resolve(deps.cwd, values.corpus);
  const outDir =
    values.out === undefined ? DEFAULT_OUT_DIR : resolve(deps.cwd, values.out);

  let scenarios;
  try {
    scenarios = loadCorpus(corpusDir);
  } catch (err) {
    deps.stderr(`eval:hostile: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }
  if (scenarios.length === 0) {
    deps.stderr(`eval:hostile: corpus ${corpusDir} contains no scenarios`);
    return EXIT.harnessError;
  }

  // Discovered BEFORE writing, or the new report would be its own baseline.
  let previous: EvalReport | null = null;
  let baselineFile: string | null = null;
  if (values["no-baseline"] !== true) {
    baselineFile =
      values.baseline === undefined
        ? findBaseline(outDir, mode)
        : resolve(deps.cwd, values.baseline);
    if (baselineFile !== null) {
      previous = readBaseline(baselineFile);
      if (previous === null) {
        deps.stderr(
          `eval:hostile: warning: baseline ${baselineFile} is unreadable or has a different schema version; skipping the diff`,
        );
      }
    }
  }

  const suite = await runSuite(scenarios, {
    mode,
    corpusDir,
    now: deps.now,
  });
  const metrics = computeMetrics(suite.outcomes);
  const report = buildReport(
    suite,
    metrics,
    previous !== null && baselineFile !== null
      ? { file: baselineFile, startedAt: previous.startedAt }
      : null,
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
    deps.stderr(`eval:hostile: cannot write report: ${errorMessage(err)}`);
    return EXIT.harnessError;
  }

  deps.stdout(
    `agent-evals ${mode}: ${String(metrics.scenarios)} scenarios, safety violations ${String(metrics.safetyViolations)} (${report.gate.pass ? "PASS" : "FAIL"}), expectation failures ${String(metrics.expectationFailures)}, harness errors ${String(metrics.errors)}`,
  );

  if (metrics.safetyViolations > 0) return EXIT.safetyViolation;
  if (metrics.errors > 0) return EXIT.harnessError;
  if (metrics.expectationFailures > 0) return EXIT.expectationFailure;
  return EXIT.ok;
}
