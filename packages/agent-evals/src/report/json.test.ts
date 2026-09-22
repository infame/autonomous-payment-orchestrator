import { describe, expect, it } from "vitest";
import type { ScenarioOutcome } from "../eval-run.js";
import { computeMetrics } from "../metrics.js";
import {
  exchange,
  observation,
  observedIntent,
  startCall,
  view,
} from "../oracles/observation-fixture.js";
import { fuzzEntries, runSuite } from "../eval-run.js";
import {
  FUZZ_GENERATOR_VERSION,
  generateFuzzScenario,
} from "../fuzz/generate.js";
import { loadCorpus } from "../scenario.js";
import { buildReport } from "./json.js";
import { reportOf, suiteOf } from "./test-support.js";
import { parseReport } from "./types.js";

describe("buildReport", () => {
  it("records a clean run as a passing gate with one ok scenario", async () => {
    const r = await reportOf("clean");
    expect(r.schemaVersion).toBe(3);
    expect(r.startedAt).toBe("2026-03-04T05:06:07.008Z");
    expect(r.corpus.scenarios).toBe(1);
    expect(r.gate).toEqual({
      name: "safety_violations",
      value: 0,
      pass: true,
    });
    expect(r.violations).toEqual([]);
    expect(r.scenarios[0]).toMatchObject({
      id: "cli-fixture-clean",
      run: 0,
      ok: true,
      startCalls: 1,
      terminalStatuses: ["executing"],
      error: null,
    });
    expect(r.live).toBeNull();
    expect(r.metrics.falseRejectRate?.denominator).toBe(1);
    expect(parseReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it("records explicit null live in hostile mode", async () => {
    const suite = await suiteOf("clean");
    const report = buildReport(
      suite,
      computeMetrics(suite.outcomes, suite.mode),
      null,
      null,
      process.cwd(),
    );
    expect(report.live).toBeNull();
    expect(report.schemaVersion).toBe(3);
  });

  it("carries a populated live block through, round-tripping via parseReport", async () => {
    const suite = { ...(await suiteOf("clean")), mode: "live" as const };
    const live: NonNullable<Awaited<ReturnType<typeof reportOf>>["live"]> = {
      model: "claude-sonnet-5",
      k: 2,
      maxCalls: 50,
      calls: 12,
      failuresByCode: { llm_unavailable: 1, other: 0 },
      stoppedEarly: false,
      scenariosPlanned: 2,
      scenariosRun: 2,
      metrics: {
        unsafeProposalRate: { numerator: 0, denominator: 1, value: 0 },
        gatedRate: null,
        consistency: { numerator: 1, denominator: 2, value: 0.5 },
        passAtK: { numerator: 1, denominator: 1, value: 1 },
      },
    };
    const report = buildReport(
      suite,
      computeMetrics(suite.outcomes, suite.mode),
      null,
      live,
      process.cwd(),
    );
    expect(report.mode).toBe("live");
    expect(report.live).toEqual(live);
    expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it("records the violating fixture as exactly one I8 violation with evidence", async () => {
    const r = await reportOf("violating");
    expect(r.gate.pass).toBe(false);
    expect(r.gate.value).toBe(1);
    expect(r.violations).toHaveLength(1);
    const [v] = r.violations;
    expect(v?.invariant).toBe("I8");
    expect(v?.evidence.source).toEqual({
      kind: "corpus",
      file: expect.stringMatching(/cli-fixture-violating\.json$/) as string,
    });
    expect(v?.evidence.intents).toHaveLength(3);
    expect(
      v?.evidence.coreCalls.filter((c) => c.method === "startPaymentWorkflow"),
    ).toHaveLength(3);
    expect(r.scenarios[0]?.ok).toBe(false);
    expect(r.scenarios[0]?.expectationFailures).toEqual([]);
  });

  it("records a harness error without an observation", async () => {
    const r = await reportOf("harness-error");
    expect(r.scenarios[0]?.error?.name).toBe("ScenarioStepError");
    expect(r.scenarios[0]?.ok).toBe(false);
    expect(r.metrics.errors).toBe(1);
    expect(r.gate.pass).toBe(true);
  });

  it("carries baseline info through", async () => {
    const r = await reportOf("clean", {
      file: "x.json",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(r.baseline).toEqual({
      file: "x.json",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("relativizes corpus.dir and scenario file paths against cwd, never absolute-local — even from a cwd outside the corpus tree", async () => {
    const suite = await suiteOf("clean");
    const outsideCwd = "/tmp/some-other-place-entirely";
    const report = buildReport(
      suite,
      computeMetrics(suite.outcomes, suite.mode),
      null,
      null,
      outsideCwd,
    );
    expect(report.corpus.dir.startsWith("/")).toBe(false);
    expect(report.corpus.dir).not.toContain("//");
    const [scenario] = report.scenarios;
    if (scenario?.source.kind !== "corpus") {
      throw new Error("expected a corpus-sourced scenario");
    }
    expect(scenario.source.file.startsWith("/")).toBe(false);
    expect(scenario.source.file).not.toContain("//");
    expect(scenario.source.file.endsWith("cli-fixture-clean.json")).toBe(true);
  });

  it("normalizes a double slash from a trailing corpus directory argument", async () => {
    const suite = await suiteOf("clean");
    const trailingSlash = { ...suite, corpusDir: `${suite.corpusDir}/` };
    const report = buildReport(
      trailingSlash,
      computeMetrics(trailingSlash.outcomes, trailingSlash.mode),
      null,
      null,
      process.cwd(),
    );
    const [scenario] = report.scenarios;
    if (scenario?.source.kind !== "corpus") {
      throw new Error("expected a corpus-sourced scenario");
    }
    expect(scenario.source.file).not.toContain("//");
    expect(scenario.source.file.endsWith("cli-fixture-clean.json")).toBe(true);
  });
});

describe("redaction", () => {
  it("never serialises reasoning, verdict detail, HTTP bodies or scenario prose", async () => {
    const base = loadCorpus().find((s) => s.id === "benign-auto-approve-01");
    if (base === undefined) throw new Error("scenario missing");
    const scenario = {
      ...base,
      text: "CANARY-TEXT-11aa Pay $120 to acme",
      description: "CANARY-DESCRIPTION-22bb",
    };
    const leaky = view({
      text: "CANARY-VIEWTEXT-33cc",
      proposal: {
        kind: "propose_payment",
        amount: 12000,
        currency: "USD",
        merchantId: "acme",
        reasoning: "CANARY-REASONING-44dd",
      },
      policyVerdict: {
        decision: "reject",
        reason: "hard_limit_exceeded",
        detail: "CANARY-DETAIL-55ee",
      },
      clarificationAnswer: "CANARY-ANSWER-66ff",
    });
    const obs = observation({
      text: scenario.text,
      intents: [observedIntent({ views: [leaky], finalView: leaky })],
      views: [leaky],
      coreCalls: [startCall()],
      http: [
        exchange({
          body: { secret: "CANARY-BODY-77aa", intent: leaky },
          coreCallIndexes: [0],
        }),
      ],
    });
    const outcome: ScenarioOutcome = {
      scenario,
      source: { kind: "corpus" },
      run: 0,
      observation: obs,
      invariants: [
        {
          id: "I1",
          title: "t",
          subjects: 1,
          violations: [
            {
              invariant: "I1",
              message: "fixed template 12000",
              coreCallIndex: 0,
              httpIndex: 0,
              intentId: "intent_1",
            },
          ],
        },
      ],
      expectationFailures: [],
      error: null,
      durationMs: 1,
    };
    const suite = {
      ...(await suiteOf("clean")),
      outcomes: [outcome],
    };
    const report = buildReport(
      suite,
      computeMetrics(suite.outcomes, suite.mode),
      null,
      null,
      process.cwd(),
    );
    expect(report.violations).toHaveLength(1);
    const text = JSON.stringify(report);
    for (const canary of [
      "CANARY-TEXT",
      "CANARY-DESCRIPTION",
      "CANARY-VIEWTEXT",
      "CANARY-REASONING",
      "CANARY-DETAIL",
      "CANARY-ANSWER",
      "CANARY-BODY",
    ]) {
      expect(text).not.toContain(canary);
    }
    expect(text).toContain("acme");
  });

  it("records fuzz provenance and never serialises generated text or description", async () => {
    const seed = "canary-seed";
    const entries = fuzzEntries(seed, 6);
    const suite = await runSuite(entries, {
      mode: "hostile",
      corpusDir: "none",
      fuzz: { seed, count: 6, generator: FUZZ_GENERATOR_VERSION },
    });
    const report = buildReport(
      suite,
      computeMetrics(suite.outcomes, suite.mode),
      null,
      null,
      process.cwd(),
    );
    expect(report.corpus.scenarios).toBe(0);
    expect(report.fuzz).toEqual({
      seed,
      count: 6,
      generator: FUZZ_GENERATOR_VERSION,
      scenarios: 6,
      startCalls: report.metrics.byCategory.fuzz.startCalls,
      safetyViolations: 0,
      errors: 0,
    });
    expect(report.scenarios.map((s) => s.source)).toEqual(
      [0, 1, 2, 3, 4, 5].map((index) => ({ kind: "fuzz", seed, index })),
    );
    const text = JSON.stringify(report);
    for (let i = 0; i < 6; i += 1) {
      const s = generateFuzzScenario(seed, i);
      expect(text).not.toContain(JSON.stringify(s.text).slice(1, -1));
      expect(text).not.toContain(s.description);
    }
    expect(parseReport(JSON.parse(text))).toEqual(report);
  });

  it("records a null fuzz block when the layer did not run", async () => {
    expect((await reportOf("clean")).fuzz).toBeNull();
  });
});

describe("baseline projection", () => {
  it.each([
    "reports/old.json",
    "/published/work/reports/old.json",
    "../old.json",
    "/published/old.json",
  ])("resolves %s against the supplied cwd without mutation", async (file) => {
    const cwd = "/published/work";
    const baseline = Object.freeze({
      file,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const suite = await suiteOf("clean");
    const report = buildReport(
      suite,
      computeMetrics(suite.outcomes, suite.mode),
      baseline,
      null,
      cwd,
    );
    expect(report.baseline?.file).toBe(
      file.includes("reports/") ? "reports/old.json" : "../old.json",
    );
    expect(baseline.file).toBe(file);
    expect(report.baseline).not.toBe(baseline);
    expect(report.baseline?.startedAt).toBe(baseline.startedAt);
    // Old schema-3 reports with absolute paths remain readable.
    expect(
      parseReport({
        ...report,
        baseline: { ...baseline, file: "/old/local/report.json" },
      })?.baseline?.file,
    ).toBe("/old/local/report.json");
  });
});
