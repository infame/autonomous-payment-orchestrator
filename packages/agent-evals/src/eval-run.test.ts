import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { clarifyProposal } from "@apo/agent-orchestrator";
import type {
  AgentProposal,
  LlmClient,
  LlmReasoningRequest,
} from "@apo/agent-orchestrator";
import {
  corpusEntries,
  fuzzEntries,
  livePasses,
  NON_HARNESS_ERROR_MESSAGE,
  runSuite,
} from "./eval-run.js";
import { FUZZ_GENERATOR_VERSION } from "./fuzz/generate.js";
import { LiveBudgetExhaustedError } from "./llm/budgeted-llm-client.js";
import { loadCorpus } from "./scenario.js";
import type { Scenario } from "./scenario.js";

/**
 * No test in this file (or anywhere in this suite) ever reads a real
 * ANTHROPIC_API_KEY or makes a real network call — `StubLlmClient` is an
 * in-repo fake, never `AnthropicLlmClient`.
 */
class StubLlmClient implements LlmClient {
  readonly name = "stub";
  readonly requests: LlmReasoningRequest[] = [];

  constructor(
    private readonly responder: (
      call: number,
    ) => AgentProposal | Promise<AgentProposal>,
  ) {}

  reason(input: LlmReasoningRequest): Promise<AgentProposal> {
    const call = this.requests.length;
    this.requests.push(input);
    return Promise.resolve(this.responder(call));
  }
}

const fixtures = new URL("./cli-fixtures/", import.meta.url);
const fixtureDir = (name: string): string =>
  fileURLToPath(new URL(`${name}/`, fixtures));

describe("runSuite", () => {
  it("returns one outcome per scenario with shape, order and durations", async () => {
    const dir = fixtureDir("clean");
    const scenarios = loadCorpus(dir);
    expect(scenarios.length).toBeGreaterThan(0);
    const startedAt = new Date("2026-01-02T03:04:05.006Z");
    const suite = await runSuite(corpusEntries(scenarios), {
      mode: "hostile",
      corpusDir: dir,
      now: () => startedAt,
    });
    expect(suite.mode).toBe("hostile");
    expect(suite.corpusDir).toBe(dir);
    expect(suite.startedAt).toBe(startedAt);
    expect(suite.durationMs).toBeGreaterThanOrEqual(0);
    expect(suite.outcomes.map((o) => o.scenario.id)).toEqual(
      scenarios.map((s) => s.id),
    );
    for (const o of suite.outcomes) {
      expect(o.error).toBeNull();
      expect(o.observation).not.toBeNull();
      expect(o.invariants.length).toBe(8);
      expect(o.expectationFailures).toEqual([]);
      expect(o.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("captures a ScenarioStepError and still returns the outcome", async () => {
    const dir = fixtureDir("harness-error");
    const suite = await runSuite(corpusEntries(loadCorpus(dir)), {
      mode: "hostile",
      corpusDir: dir,
    });
    expect(suite.outcomes).toHaveLength(1);
    const [o] = suite.outcomes;
    expect(o?.error?.name).toBe("ScenarioStepError");
    expect(o?.error?.message).toContain("intent 5");
    expect(o?.observation).toBeNull();
    expect(o?.invariants).toEqual([]);
  });

  it("does not abort the rest of the suite after a failing scenario", async () => {
    const scenarios = loadCorpus(fixtureDir("harness-error")).concat(
      loadCorpus(fixtureDir("clean")),
    );
    const suite = await runSuite(corpusEntries(scenarios), {
      mode: "hostile",
      corpusDir: "mixed",
    });
    expect(suite.outcomes.map((o) => o.error?.name ?? null)).toEqual([
      "ScenarioStepError",
      null,
    ]);
    expect(suite.outcomes[1]?.observation?.coreCalls.length).toBeGreaterThan(0);
  });

  it("replaces a non-harness error message with a fixed string and keeps its name", async () => {
    const [base] = loadCorpus(fixtureDir("clean"));
    if (base === undefined) throw new Error("fixture missing");
    const booby: Scenario = {
      ...base,
      get llm(): Scenario["llm"] {
        throw new TypeError("CANARY-PAYLOAD-9f3a scenario text and body");
      },
    };
    const suite = await runSuite(corpusEntries([booby]), {
      mode: "hostile",
      corpusDir: "canary",
    });
    expect(suite.outcomes[0]?.error).toEqual({
      name: "TypeError",
      message: NON_HARNESS_ERROR_MESSAGE,
    });
    expect(JSON.stringify(suite.outcomes[0]?.error)).not.toContain("CANARY");
  });

  it("tags outcomes with their source and records the fuzz run on the suite", async () => {
    const dir = fixtureDir("clean");
    const entries = [
      ...corpusEntries(loadCorpus(dir)),
      ...fuzzEntries("src-check", 3),
    ];
    const fuzz = {
      seed: "src-check",
      count: 3,
      generator: FUZZ_GENERATOR_VERSION,
    };
    const suite = await runSuite(entries, {
      mode: "hostile",
      corpusDir: dir,
      fuzz,
    });
    expect(suite.fuzz).toEqual(fuzz);
    expect(suite.outcomes.map((o) => o.source)).toEqual([
      { kind: "corpus" },
      { kind: "fuzz", seed: "src-check", index: 0 },
      { kind: "fuzz", seed: "src-check", index: 1 },
      { kind: "fuzz", seed: "src-check", index: 2 },
    ]);
    const bare = await runSuite(corpusEntries(loadCorpus(dir)), {
      mode: "hostile",
      corpusDir: dir,
    });
    expect(bare.fuzz).toBeNull();
  });
});

describe("livePasses", () => {
  it("repeats every entry k times, blocked by run, tagging run 0-indexed", () => {
    const entries = corpusEntries(loadCorpus(fixtureDir("clean")));
    const passes = livePasses(entries, 3);
    expect(passes).toHaveLength(entries.length * 3);
    expect(passes.map((e) => e.run)).toEqual([0, 1, 2]);
    expect(passes.every((e) => e.scenario === entries[0]?.scenario)).toBe(true);
  });

  it("k=1 yields exactly the original entries labelled run 0", () => {
    const entries = corpusEntries(loadCorpus(fixtureDir("clean")));
    expect(livePasses(entries, 1)).toEqual(
      entries.map((e) => ({ ...e, run: 0 })),
    );
  });
});

describe("runSuite — live mode", () => {
  it("outcome.run defaults to 0 for a plain corpus entry", async () => {
    const dir = fixtureDir("clean");
    const suite = await runSuite(corpusEntries(loadCorpus(dir)), {
      mode: "hostile",
      corpusDir: dir,
    });
    expect(suite.outcomes.map((o) => o.run)).toEqual([0]);
  });

  it("threads livePasses' run index through to each outcome", async () => {
    const dir = fixtureDir("clean");
    const entries = livePasses(corpusEntries(loadCorpus(dir)), 2);
    const llm = new StubLlmClient(() =>
      clarifyProposal("which invoice did you mean?"),
    );
    const suite = await runSuite(entries, {
      mode: "live",
      corpusDir: dir,
      llm,
    });
    expect(suite.mode).toBe("live");
    expect(suite.outcomes.map((o) => o.run)).toEqual([0, 1]);
    expect(llm.requests).toHaveLength(2);
  });

  it("RunSuiteOptions.llm replaces every entry's own scripted client, not just decorates it", async () => {
    const dir = fixtureDir("clean");
    const scenarios = loadCorpus(dir);
    expect(scenarios[0]?.llm.mode).toBe("script");
    const llm = new StubLlmClient(() => clarifyProposal("clarifying instead"));
    const suite = await runSuite(corpusEntries(scenarios), {
      mode: "live",
      corpusDir: dir,
      llm,
    });
    expect(llm.requests).toHaveLength(1);
    const [o] = suite.outcomes;
    expect(o?.error).toBeNull();
    // The scripted proposal was a payment; the override made it a clarify
    // instead, so the intent never reaches "executing" — proof the override
    // actually drove the run rather than the fixture's own script.
    expect(o?.observation?.finalView?.status).toBe("needs_clarification");
  });

  it("stopBefore, checked before each entry, stops the suite and counts what it skipped", async () => {
    const dir = fixtureDir("clean");
    const entries = livePasses(corpusEntries(loadCorpus(dir)), 3);
    const llm = new StubLlmClient(() =>
      clarifyProposal("which invoice did you mean?"),
    );
    let allowed = 1;
    const suite = await runSuite(entries, {
      mode: "live",
      corpusDir: dir,
      llm,
      stopBefore: () => allowed-- <= 0,
    });
    expect(suite.stoppedEarly).toBe(true);
    expect(suite.outcomes).toHaveLength(1);
    expect(suite.skipped).toBe(entries.length - 1);
    expect(suite.outcomes.length + suite.skipped).toBe(entries.length);
  });

  it("never trips when stopBefore always returns false", async () => {
    const dir = fixtureDir("clean");
    const suite = await runSuite(corpusEntries(loadCorpus(dir)), {
      mode: "hostile",
      corpusDir: dir,
      stopBefore: () => false,
    });
    expect(suite.stoppedEarly).toBe(false);
    expect(suite.skipped).toBe(0);
  });

  it("harnessErrorOf recognizes LiveBudgetExhaustedError as harness-authored and keeps its message", async () => {
    // `LlmClient.reason()` always runs behind Hono (`SubmitIntent`/
    // `AnswerClarification` call it, awaited, inside a route handler), and
    // this app's single `app.onError` maps EVERY thrown error — including
    // `LiveBudgetExhaustedError` — to a JSON response; nothing thrown inside
    // a route handler ever escapes `app.request()` as a rejection (verified
    // directly: `app.request()` resolves with status 500 even when
    // `LlmClient.reason()` throws synchronously). So a real mid-scenario
    // budget exhaustion becomes an ordinary observed 500 on that one HTTP
    // exchange (see `e2e/live-budget.test.ts` for that end-to-end shape),
    // never a thrown `LiveBudgetExhaustedError` reaching `runOne`'s own
    // try/catch. This test instead exercises `harnessErrorOf`'s
    // classification directly — the same technique the canary test above
    // uses (a scenario field accessed synchronously, before any HTTP call,
    // whose getter throws) — to prove the allow-list entry added in step 2
    // does what it says: the class's own message survives untouched,
    // exactly like `ScriptExhaustedError`'s.
    const [base] = loadCorpus(fixtureDir("clean"));
    if (base === undefined) throw new Error("fixture missing");
    const booby: Scenario = {
      ...base,
      get text(): string {
        throw new LiveBudgetExhaustedError(7);
      },
    };
    const suite = await runSuite(corpusEntries([booby]), {
      mode: "live",
      corpusDir: "canary",
    });
    expect(suite.outcomes[0]?.error).toEqual({
      name: "LiveBudgetExhaustedError",
      message: "BudgetedLlmClient: call budget of 7 exhausted",
    });
  });
});
