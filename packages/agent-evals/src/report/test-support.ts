/** Shared helpers for the report-layer tests: real suites over the CLI fixtures. */
import { fileURLToPath, URL } from "node:url";
import { corpusEntries, runSuite } from "../eval-run.js";
import type { SuiteResult } from "../eval-run.js";
import { computeMetrics } from "../metrics.js";
import { loadCorpus } from "../scenario.js";
import { buildReport } from "./json.js";
import type { EvalReport } from "./types.js";

export function fixtureDir(name: string): string {
  return fileURLToPath(new URL(`../cli-fixtures/${name}/`, import.meta.url));
}

export async function suiteOf(
  name: string,
  startedAt = new Date("2026-03-04T05:06:07.008Z"),
): Promise<SuiteResult> {
  const dir = fixtureDir(name);
  return runSuite(corpusEntries(loadCorpus(dir)), {
    mode: "hostile",
    corpusDir: dir,
    now: () => startedAt,
  });
}

export async function reportOf(
  name: string,
  baseline: EvalReport["baseline"] = null,
  startedAt?: Date,
): Promise<EvalReport> {
  const suite = await suiteOf(name, startedAt);
  return buildReport(suite, computeMetrics(suite.outcomes), baseline);
}
