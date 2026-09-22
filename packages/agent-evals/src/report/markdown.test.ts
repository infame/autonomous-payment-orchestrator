import { describe, expect, it } from "vitest";
import { diffReports } from "./diff.js";
import { cell, renderMarkdown } from "./markdown.js";
import { reportOf } from "./test-support.js";
import type { EvalReport } from "./types.js";

const baseline: EvalReport["baseline"] = {
  file: "prev.json",
  startedAt: "2026-01-01T00:00:00.000Z",
};

describe("renderMarkdown", () => {
  it("renders one row per category and the PASS gate line", async () => {
    const md = renderMarkdown(await reportOf("clean"), null);
    expect(md).toContain("Gate safety_violations = 0: PASS");
    for (const c of [
      "benign",
      "ambiguous",
      "injection",
      "limits",
      "duplicate",
      "tenancy",
      "clarify-abuse",
    ]) {
      expect(
        md.split("\n").filter((l) => l.startsWith(`| ${c} |`)),
      ).toHaveLength(1);
    }
    expect(md).toContain("No previous run to compare against.");
    expect(md).toContain("| falseRejectRate | 0 | 1 | 0.000 |");
    expect(md).toContain("| guardrailCatchRate | n/a | 0 | n/a |");
  });

  it("names the invariant and corpus file in the violations section", async () => {
    const md = renderMarkdown(await reportOf("violating"), null);
    expect(md).toContain("Gate safety_violations = 1: FAIL");
    expect(md).toContain("### cli-fixture-violating: I8");
    expect(md).toContain("cli-fixture-violating.json");
  });

  it("renders the diff branch", async () => {
    const previous = await reportOf("clean");
    const current = await reportOf("violating", baseline);
    const md = renderMarkdown(current, diffReports(previous, current));
    expect(md).not.toContain("No previous run");
    expect(md).toContain("- New violations: cli-fixture-violating/I8");
    expect(md).toContain("| safetyViolations | 0 | 1 |");
  });

  it("sanitizes model-controlled merchantId so it cannot break a cell or inject a heading", async () => {
    const r = await reportOf("violating");
    const [v] = r.violations;
    if (v === undefined) throw new Error("no violation");
    const hostile = "evil|x\n# INJECTED\u0007`y";
    const patched: EvalReport = {
      ...r,
      violations: [
        {
          ...v,
          evidence: {
            ...v.evidence,
            coreCalls: v.evidence.coreCalls.map((c) =>
              c.method === "startPaymentWorkflow"
                ? { ...c, merchantId: hostile }
                : c,
            ),
          },
        },
      ],
    };
    const md = renderMarkdown(patched, null);
    expect(md).not.toContain("\u0007");
    expect(md).not.toMatch(/^# INJECTED/m);
    expect(md).toContain("evilx# INJECTEDy");
    const startRows = md
      .split("\n")
      .filter((l) => l.includes("startPaymentWorkflow"));
    expect(startRows.length).toBeGreaterThan(0);
    for (const l of startRows) expect(l.split(" | ")).toHaveLength(3);
  });

  it("strips angle brackets and square brackets so no tag or link can form", async () => {
    const r = await reportOf("violating");
    const [v] = r.violations;
    if (v === undefined) throw new Error("no violation");
    const hostile = "evil](http://x)<img src=x>`|";
    const patched: EvalReport = {
      ...r,
      violations: [
        {
          ...v,
          evidence: {
            ...v.evidence,
            coreCalls: v.evidence.coreCalls.map((c) =>
              c.method === "startPaymentWorkflow"
                ? { ...c, merchantId: hostile }
                : c,
            ),
          },
        },
      ],
    };
    const md = renderMarkdown(patched, null);
    const startRows = md
      .split("\n")
      .filter((l) => l.includes("startPaymentWorkflow"));
    expect(startRows.length).toBeGreaterThan(0);
    for (const l of startRows) {
      expect(l).not.toMatch(/[<>[\]`]/);
      expect(l.split(" | ")).toHaveLength(3);
    }
    expect(cell(hostile)).toBe("evil(http://x)img src=x");
  });

  it("renders a Fuzz section: disabled when null, provenance when present", async () => {
    const r = await reportOf("clean");
    expect(renderMarkdown(r, null)).toContain("Fuzz layer disabled.");
    const withFuzz: EvalReport = {
      ...r,
      fuzz: {
        seed: "my-seed",
        count: 200,
        generator: 1,
        scenarios: 200,
        startCalls: 150,
        safetyViolations: 0,
        errors: 0,
      },
    };
    const md = renderMarkdown(withFuzz, null);
    expect(md).toContain("## Fuzz");
    expect(md).toContain("- Seed: my-seed");
    expect(md).toContain("- Generator version: 1");
    expect(md).toContain(
      "- Scenarios: 200; start calls 150; safety violations 0; harness errors 0",
    );
    expect(md).not.toContain("Fuzz layer disabled.");
  });

  it("names seed, index and a replay command for a fuzz violation, sanitized", async () => {
    const r = await reportOf("violating");
    const [v] = r.violations;
    if (v === undefined) throw new Error("no violation");
    const patched: EvalReport = {
      ...r,
      violations: [
        {
          ...v,
          evidence: {
            ...v.evidence,
            source: { kind: "fuzz", seed: "a`b<c>[d]", index: 41 },
          },
        },
      ],
    };
    const md = renderMarkdown(patched, null);
    expect(md).toContain("Fuzz case: seed abcd index 41");
    expect(md).toContain("--fuzz-seed abcd --fuzz-count 42 --dump-fuzz");
    expect(md).not.toContain("Corpus file:");
  });

  it("truncates long values to 64 characters", () => {
    expect(cell("a".repeat(200))).toHaveLength(64);
    expect(cell("short")).toBe("short");
  });
});
