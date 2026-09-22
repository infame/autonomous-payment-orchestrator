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
    expect(r.schemaVersion).toBe(2);
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
      ok: true,
      startCalls: 1,
      terminalStatuses: ["executing"],
      error: null,
    });
    expect(r.metrics.falseRejectRate?.denominator).toBe(1);
    expect(parseReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
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
    const report = buildReport(suite, computeMetrics(suite.outcomes), null);
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
    const report = buildReport(suite, computeMetrics(suite.outcomes), null);
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
