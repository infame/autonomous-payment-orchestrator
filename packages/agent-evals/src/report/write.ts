/**
 * The only node:fs module of the report layer: baseline discovery and
 * timestamped writes. Filenames are `<YYYYMMDD>T<HHMMSSmmm>Z-<mode>.{json,md}`
 * (UTC, ms precision), so lexicographic order is chronological order.
 * Call `findBaseline` BEFORE `writeReport`, or the new file is its own baseline.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReport } from "./types.js";
import type { EvalReport } from "./types.js";

export interface WrittenReport {
  readonly jsonPath: string;
  readonly mdPath: string;
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** Newest `*-<mode>.json` by filename, or null. */
export function findBaseline(outDir: string, mode: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^\\d{8}T\\d{9}Z-${mode}\\.json$`);
  const newest = entries
    .filter((f) => pattern.test(f))
    .sort()
    .at(-1);
  return newest === undefined ? null : join(outDir, newest);
}

/** Never throws: missing file, bad JSON or a schema mismatch all give null. */
export function readBaseline(file: string): EvalReport | null {
  try {
    return parseReport(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeReport(
  report: EvalReport,
  markdown: string,
  outDir: string,
  at: Date,
): WrittenReport {
  mkdirSync(outDir, { recursive: true });
  const base = `${stamp(at)}-${report.mode}`;
  const jsonPath = join(outDir, `${base}.json`);
  const mdPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { jsonPath, mdPath };
}
