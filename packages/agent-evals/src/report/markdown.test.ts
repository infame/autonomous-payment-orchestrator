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

  it("truncates long values to 64 characters", () => {
    expect(cell("a".repeat(200))).toHaveLength(64);
    expect(cell("short")).toBe("short");
  });
});
