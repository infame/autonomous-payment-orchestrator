import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import type { CliDeps } from "./cli.js";
import { fixtureDir } from "./report/test-support.js";
import { parseReport } from "./report/types.js";
import type { EvalReport } from "./report/types.js";

interface Harness {
  readonly deps: CliDeps;
  readonly out: string[];
  readonly err: string[];
}

function harness(at = new Date("2026-03-04T05:06:07.008Z")): Harness {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      now: () => at,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      cwd: process.cwd(),
    },
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "evals-cli-"));

function reports(dir: string): { json: string[]; md: string[] } {
  const files = readdirSync(dir).sort();
  return {
    json: files.filter((f) => f.endsWith(".json")),
    md: files.filter((f) => f.endsWith(".md")),
  };
}

function readReport(dir: string): EvalReport {
  const [file] = reports(dir).json;
  if (file === undefined) throw new Error("no report written");
  const parsed = parseReport(JSON.parse(readFileSync(join(dir, file), "utf8")));
  if (parsed === null) throw new Error("report does not parse");
  return parsed;
}

describe("runCli exit codes", () => {
  it("exits 0 on a clean corpus and writes both report files", async () => {
    const out = tmp();
    const h = harness();
    const code = await runCli(
      ["--corpus", fixtureDir("clean"), "--out", out],
      h.deps,
    );
    expect(code).toBe(EXIT.ok);
    expect(reports(out).json).toHaveLength(1);
    expect(reports(out).md).toHaveLength(1);
    const r = readReport(out);
    expect(r.gate.pass).toBe(true);
    expect(r.corpus.scenarios).toBe(1);
  });

  it("exits 1 on a safety violation and records exactly one I8, no expectation failures", async () => {
    const out = tmp();
    const code = await runCli(
      ["--corpus", fixtureDir("violating"), "--out", out],
      harness().deps,
    );
    expect(code).toBe(EXIT.safetyViolation);
    const r = readReport(out);
    expect(r.violations.map((v) => v.invariant)).toEqual(["I8"]);
    expect(r.metrics.expectationFailures).toBe(0);
    expect(r.gate.pass).toBe(false);
    expect(reports(out).md).toHaveLength(1);
  });

  it("exits 2 on expectation failures alone", async () => {
    const out = tmp();
    const code = await runCli(
      ["--corpus", fixtureDir("expectation-failure"), "--out", out],
      harness().deps,
    );
    expect(code).toBe(EXIT.expectationFailure);
    const r = readReport(out);
    expect(r.metrics.safetyViolations).toBe(0);
    expect(r.metrics.expectationFailures).toBeGreaterThan(0);
    expect(reports(out).json).toHaveLength(1);
  });

  it("exits 3 on a scenario step error but still writes the report", async () => {
    const out = tmp();
    const code = await runCli(
      ["--corpus", fixtureDir("harness-error"), "--out", out],
      harness().deps,
    );
    expect(code).toBe(EXIT.harnessError);
    expect(readReport(out).metrics.errors).toBe(1);
  });

  it("exits 3 for live mode, unknown flag, missing corpus dir and empty corpus, writing nothing", async () => {
    const out = tmp();
    const empty = tmp();
    const cases: string[][] = [
      ["--mode", "live", "--out", out],
      ["--mode", "nonsense", "--out", out],
      ["--bogus", "--out", out],
      ["--corpus", join(tmp(), "does-not-exist"), "--out", out],
      ["--corpus", empty, "--out", out],
      ["--baseline", "x.json", "--no-baseline", "--out", out],
    ];
    for (const argv of cases) {
      const h = harness();
      expect(await runCli(argv, h.deps), argv.join(" ")).toBe(
        EXIT.harnessError,
      );
      expect(h.err.length).toBeGreaterThan(0);
    }
    expect(readdirSync(out)).toEqual([]);
  });

  it("says live mode waits for step 7", async () => {
    const h = harness();
    await runCli(["--mode", "live"], h.deps);
    expect(h.err.join("\n")).toContain("step 7");
  });

  it("--help exits 0, prints usage and writes nothing", async () => {
    const out = tmp();
    const h = harness();
    expect(await runCli(["--help", "--out", out], h.deps)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain("Usage");
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("runCli baseline", () => {
  it("diffs against an explicit previous report", async () => {
    const prevOut = tmp();
    await runCli(
      ["--corpus", fixtureDir("clean"), "--out", prevOut],
      harness(new Date("2026-01-01T00:00:00.000Z")).deps,
    );
    const [prev] = reports(prevOut).json;
    if (prev === undefined) throw new Error("no previous report");
    const out = tmp();
    const code = await runCli(
      [
        "--corpus",
        fixtureDir("violating"),
        "--out",
        out,
        "--baseline",
        join(prevOut, prev),
      ],
      harness().deps,
    );
    expect(code).toBe(EXIT.safetyViolation);
    const r = readReport(out);
    expect(r.baseline?.startedAt).toBe("2026-01-01T00:00:00.000Z");
    const [md] = reports(out).md;
    const text = readFileSync(join(out, md ?? ""), "utf8");
    expect(text).toContain("New violations: cli-fixture-violating/I8");
    expect(text).not.toContain("No previous run");
  });

  it("uses the newest report in --out by default, and --no-baseline skips it", async () => {
    const out = tmp();
    const args = ["--corpus", fixtureDir("clean"), "--out", out];
    await runCli(args, harness(new Date("2026-01-01T00:00:00.000Z")).deps);
    await runCli(args, harness(new Date("2026-01-02T00:00:00.000Z")).deps);
    const files = reports(out).json;
    expect(files).toHaveLength(2);
    const second = JSON.parse(
      readFileSync(join(out, files[1] ?? ""), "utf8"),
    ) as EvalReport;
    expect(second.baseline?.startedAt).toBe("2026-01-01T00:00:00.000Z");
    await runCli(
      [...args, "--no-baseline"],
      harness(new Date("2026-01-03T00:00:00.000Z")).deps,
    );
    const third = JSON.parse(
      readFileSync(join(out, reports(out).json[2] ?? ""), "utf8"),
    ) as EvalReport;
    expect(third.baseline).toBeNull();
  });

  it("degrades a corrupt baseline to a warning without failing", async () => {
    const out = tmp();
    const bad = join(tmp(), "bad.json");
    writeFileSync(bad, "{corrupt");
    const h = harness();
    const code = await runCli(
      ["--corpus", fixtureDir("clean"), "--out", out, "--baseline", bad],
      h.deps,
    );
    expect(code).toBe(EXIT.ok);
    expect(h.err.join("\n")).toContain("warning");
    expect(readReport(out).baseline).toBeNull();
  });
});
