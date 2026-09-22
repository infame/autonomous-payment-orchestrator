import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import type { CliDeps } from "./cli.js";
import { FUZZ_GENERATOR_VERSION } from "./fuzz/generate.js";
import { fixtureDir } from "./report/test-support.js";
import { parseReport } from "./report/types.js";
import { parseScenarioValue } from "./scenario.js";
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
      // Deliberately empty: no test in this file may read a real
      // ANTHROPIC_API_KEY. Live-mode-specific tests live in
      // cli-live.test.ts, which always injects `createLiveLlm`; the
      // live-mode cases exercised here only ever reach `loadLiveConfig`
      // failing on a missing key (exit 3), never a real client.
      env: {},
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

function mixedCorpus(fixtures: readonly string[]): {
  corpus: string;
  out: string;
} {
  const root = tmp();
  const corpus = join(root, "corpus");
  const out = join(root, "out");
  mkdirSync(corpus);
  mkdirSync(out);
  for (const name of fixtures) {
    const dir = fixtureDir(name);
    for (const file of readdirSync(dir)) {
      copyFileSync(join(dir, file), join(corpus, file));
    }
  }
  return { corpus, out };
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

  it("gives a safety violation precedence over a harness error in the same run", async () => {
    const { corpus, out } = mixedCorpus(["violating", "harness-error"]);
    const code = await runCli(
      ["--corpus", corpus, "--out", out],
      harness().deps,
    );
    expect(code).toBe(EXIT.safetyViolation);
    const r = readReport(out);
    expect(r.metrics.safetyViolations).toBe(1);
    expect(r.metrics.errors).toBe(1);
  });

  it("gives a harness error precedence over expectation failures", async () => {
    const { corpus, out } = mixedCorpus([
      "expectation-failure",
      "harness-error",
    ]);
    const code = await runCli(
      ["--corpus", corpus, "--out", out],
      harness().deps,
    );
    expect(code).toBe(EXIT.harnessError);
    const r = readReport(out);
    expect(r.metrics.safetyViolations).toBe(0);
    expect(r.metrics.errors).toBe(1);
    expect(r.metrics.expectationFailures).toBeGreaterThan(0);
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

  it("live mode without an ANTHROPIC_API_KEY fails at config load, never touching the corpus", async () => {
    const h = harness();
    const code = await runCli(["--mode", "live"], h.deps);
    expect(code).toBe(EXIT.harnessError);
    expect(h.err.join("\n")).toContain("ANTHROPIC_API_KEY");
  });

  it("--help exits 0, prints usage naming both modes, and writes nothing", async () => {
    const out = tmp();
    const h = harness();
    expect(await runCli(["--help", "--out", out], h.deps)).toBe(EXIT.ok);
    expect(h.out.join("\n")).toContain("Usage");
    expect(h.out.join("\n")).toContain("eval:live");
    expect(h.out.join("\n")).toContain("--k");
    expect(h.out.join("\n")).toContain("--max-calls");
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

describe("runCli fuzz", () => {
  const clean = ["--corpus", fixtureDir("clean")];

  it("--fuzz-count 0 disables the layer: no fuzz scenarios and report.fuzz is null", async () => {
    const out = tmp();
    const code = await runCli(
      [...clean, "--out", out, "--fuzz-count", "0"],
      harness().deps,
    );
    expect(code).toBe(EXIT.ok);
    const r = readReport(out);
    expect(r.fuzz).toBeNull();
    expect(r.scenarios.every((s) => s.source.kind === "corpus")).toBe(true);
    expect(r.metrics.byCategory.fuzz.scenarios).toBe(0);
  });

  it("--fuzz-count 5 appends exactly 5 generated scenarios and records seed and generator", async () => {
    const out = tmp();
    const code = await runCli(
      [...clean, "--out", out, "--fuzz-count", "5", "--fuzz-seed", "cli-seed"],
      harness().deps,
    );
    expect(code).toBe(EXIT.ok);
    const r = readReport(out);
    expect(r.corpus.scenarios).toBe(1);
    expect(r.scenarios).toHaveLength(6);
    expect(r.scenarios.filter((s) => s.source.kind === "fuzz")).toHaveLength(5);
    expect(r.gate.pass).toBe(true);
    expect(r.fuzz).toMatchObject({
      seed: "cli-seed",
      count: 5,
      generator: FUZZ_GENERATOR_VERSION,
      scenarios: 5,
      safetyViolations: 0,
      errors: 0,
    });
  });

  it("the same seed yields identical scenario id lists across runs", async () => {
    const ids = async (): Promise<string[]> => {
      const out = tmp();
      await runCli(
        [
          ...clean,
          "--out",
          out,
          "--fuzz-count",
          "7",
          "--fuzz-seed",
          "same-seed",
        ],
        harness().deps,
      );
      return readReport(out).scenarios.map((s) => s.id);
    };
    expect(await ids()).toEqual(await ids());
  });

  it("exits 3 on a bad seed or count, writing nothing", async () => {
    const out = tmp();
    const cases: string[][] = [
      ["--fuzz-seed", "Bad Seed"],
      ["--fuzz-seed", "../escape"],
      ["--fuzz-count", "-1"],
      ["--fuzz-count", "1.5"],
      ["--fuzz-count", "abc"],
      ["--fuzz-count", "10001"],
    ];
    for (const extra of cases) {
      const h = harness();
      expect(
        await runCli([...clean, "--out", out, ...extra], h.deps),
        extra.join(" "),
      ).toBe(EXIT.harnessError);
      expect(h.err.join("\n")).toContain("--fuzz-");
    }
    expect(readdirSync(out)).toEqual([]);
  });

  it("--dump-fuzz writes one loadable scenario file per generated case", async () => {
    const out = tmp();
    const dump = join(tmp(), "dump");
    const h = harness();
    await runCli(
      [
        ...clean,
        "--out",
        out,
        "--fuzz-count",
        "4",
        "--fuzz-seed",
        "dump-seed",
        "--dump-fuzz",
        dump,
      ],
      h.deps,
    );
    const files = readdirSync(dump).sort();
    expect(files).toEqual([
      "fuzz-dump-seed-0000.json",
      "fuzz-dump-seed-0001.json",
      "fuzz-dump-seed-0002.json",
      "fuzz-dump-seed-0003.json",
    ]);
    for (const f of files) {
      const scenario = parseScenarioValue(
        f,
        JSON.parse(readFileSync(join(dump, f), "utf8")),
      );
      expect(`${scenario.id}.json`).toBe(f);
    }
    expect(h.out.join("\n")).toContain("wrote 4 scenarios");
  });
});
