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

  it("renders 'Not a live run.' for a hostile report (live is null)", async () => {
    const md = renderMarkdown(await reportOf("clean"), null);
    expect(md).toContain("## Live run");
    expect(md).toContain("Not a live run.");
  });

  it("renders model, k, budget and live metrics, without a PARTIAL banner when not stopped early", async () => {
    const r = await reportOf("clean");
    const live: EvalReport["live"] = {
      model: "claude-sonnet-5",
      k: 2,
      maxCalls: 50,
      calls: 30,
      failuresByCode: { llm_unavailable: 1 },
      stoppedEarly: false,
      scenariosPlanned: 2,
      scenariosRun: 2,
      metrics: {
        unsafeProposalRate: { numerator: 1, denominator: 2, value: 0.5 },
        gatedRate: null,
        consistency: { numerator: 1, denominator: 4, value: 0.25 },
        passAtK: { numerator: 1, denominator: 1, value: 1 },
      },
    };
    const md = renderMarkdown({ ...r, live }, null);
    expect(md).toContain("- Model: claude-sonnet-5");
    expect(md).toContain("- k: 2");
    expect(md).toContain("- Budget: 30 / 50 calls used");
    expect(md).toContain("- Entries: 2 run of 2 planned");
    expect(md).not.toContain("PARTIAL");
    expect(md).toContain("| llm_unavailable | 1 |");
    expect(md).toContain("| unsafeProposalRate | 1 | 2 | 0.500 |");
    expect(md).toContain("| gatedRate | n/a | 0 | n/a |");
    expect(md).toContain("| consistency | 1 | 4 | 0.250 |");
    expect(md).toContain("| passAtK | 1 | 1 | 1.000 |");
  });

  it("renders the PARTIAL banner when stoppedEarly, and sanitizes an env-controlled model name", async () => {
    const r = await reportOf("clean");
    const live: EvalReport["live"] = {
      model: "evil|model\n# INJECTED",
      k: 1,
      maxCalls: 5,
      calls: 5,
      failuresByCode: {},
      stoppedEarly: true,
      scenariosPlanned: 10,
      scenariosRun: 5,
      metrics: {
        unsafeProposalRate: null,
        gatedRate: null,
        consistency: null,
        passAtK: null,
      },
    };
    const md = renderMarkdown({ ...r, live }, null);
    expect(md).toContain("**PARTIAL: budget exhausted after 5 of 10 runs**");
    expect(md).not.toMatch(/^# INJECTED/m);
    expect(md).toContain("- Model: evilmodel# INJECTED");
  });

  it("renders 'None.' for an empty failures-by-code table instead of a headerless table", async () => {
    const r = await reportOf("clean");
    const live: EvalReport["live"] = {
      model: "claude-sonnet-5",
      k: 1,
      maxCalls: 10,
      calls: 3,
      failuresByCode: {},
      stoppedEarly: false,
      scenariosPlanned: 3,
      scenariosRun: 3,
      metrics: {
        unsafeProposalRate: null,
        gatedRate: null,
        consistency: null,
        passAtK: null,
      },
    };
    const md = renderMarkdown({ ...r, live }, null);
    const failuresSection = md.slice(
      md.indexOf("Failures by code:"),
      md.indexOf("Live metrics:"),
    );
    expect(failuresSection).toContain("None.");
    expect(failuresSection).not.toContain("| Code | Count |");
  });
});
