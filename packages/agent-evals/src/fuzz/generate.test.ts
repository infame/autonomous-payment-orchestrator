import { extractGroundedAmounts } from "@apo/agent-orchestrator";
import { describe, expect, it } from "vitest";
import { loosensDefaults } from "../policy-overrides.js";
import { parseScenarioValue } from "../scenario.js";
import type { Scenario } from "../scenario.js";
import {
  DEFAULT_FUZZ_COUNT,
  DEFAULT_FUZZ_SEED,
  FUZZ_SEED_PATTERN,
  FuzzGenerationError,
  fuzzScenarioId,
  generateFuzzScenario,
  generateFuzzScenarios,
} from "./generate.js";

const batch = generateFuzzScenarios(DEFAULT_FUZZ_SEED, DEFAULT_FUZZ_COUNT);

describe("generator determinism", () => {
  it("batch[i] deep-equals generateFuzzScenario(seed, i)", () => {
    const small = generateFuzzScenarios("law-check", 40);
    for (const [i, s] of small.entries()) {
      expect(s).toEqual(generateFuzzScenario("law-check", i));
    }
    expect(generateFuzzScenarios("law-check", 10)).toEqual(small.slice(0, 10));
  });

  it("two calls deep-equal; a different seed differs", () => {
    expect(generateFuzzScenario("s1", 7)).toEqual(
      generateFuzzScenario("s1", 7),
    );
    expect(generateFuzzScenario("s1", 7)).not.toEqual(
      generateFuzzScenario("s2", 7),
    );
    expect(generateFuzzScenario("s1", 7)).not.toEqual(
      generateFuzzScenario("s1", 8),
    );
  });

  it("rejects an invalid seed or index instead of interpolating them", () => {
    for (const seed of [
      "",
      "UPPER",
      "a b",
      "-lead",
      "a--b",
      "x".repeat(33),
      "../x",
    ]) {
      expect(FUZZ_SEED_PATTERN.test(seed), seed).toBe(false);
      expect(() => generateFuzzScenario(seed, 0)).toThrow(FuzzGenerationError);
    }
    expect(() => generateFuzzScenario("ok", -1)).toThrow(FuzzGenerationError);
    expect(() => generateFuzzScenario("ok", 1.5)).toThrow(FuzzGenerationError);
  });
});

describe("generator output validity", () => {
  const many: Scenario[] = ["apo-2026-09", "second-seed", "third-seed"].flatMap(
    (seed) => [...generateFuzzScenarios(seed, 170)],
  );

  it("re-parses under the scenario gate with unique, well-formed ids", () => {
    expect(many).toHaveLength(510);
    for (const s of many) {
      expect(parseScenarioValue("re-parse", s)).toEqual(s);
      expect(s.category).toBe("fuzz");
    }
    for (const seed of ["apo-2026-09", "second-seed", "third-seed"]) {
      const ids = many
        .filter((s) => s.id.startsWith(`fuzz-${seed}-`))
        .map((s) => s.id);
      expect(ids).toEqual(ids.map((_, i) => fuzzScenarioId(seed, i)));
    }
    expect(new Set(many.map((s) => s.id)).size).toBe(many.length);
  });

  it("never sets dailyRateLimit, never submits more than 3 times, never loosens a default", () => {
    for (const s of many) {
      expect(s.policy?.dailyRateLimit, s.id).toBeUndefined();
      const submits =
        1 + (s.steps ?? []).filter((x) => x.kind === "submit").length;
      expect(submits, s.id).toBeLessThanOrEqual(3);
      if (s.policy !== undefined) {
        expect(loosensDefaults(s.policy), s.id).toBe(false);
        const hard = s.policy.maxHardLimitAmount ?? 500_000;
        const auto = s.policy.maxAutoApproveAmount ?? 50_000;
        expect(hard, s.id).toBeGreaterThanOrEqual(auto);
      }
    }
  });

  it("emits only explicit step intents proven in range and sizes scripts generously", () => {
    for (const s of many) {
      const keys = new Set<string>(
        s.idempotencyKey === undefined ? [] : [s.idempotencyKey],
      );
      let intents = 1;
      let ownerClarifies = 0;
      for (const step of s.steps ?? []) {
        if (step.kind === "submit") {
          if (
            step.idempotencyKey === undefined ||
            !keys.has(step.idempotencyKey)
          ) {
            intents += 1;
          }
          if (step.idempotencyKey !== undefined) keys.add(step.idempotencyKey);
          continue;
        }
        if (step.intent !== undefined) {
          expect(step.intent, s.id).toBeLessThan(intents);
        }
        if (step.kind === "clarify" && step.as === undefined)
          ownerClarifies += 1;
      }
      if (s.llm.mode !== "script")
        throw new Error("generator emits script mode only");
      expect(s.llm.proposals.length, s.id).toBeGreaterThanOrEqual(
        1 + (intents - 1) + ownerClarifies + 1,
      );
    }
  });
});

describe("generator coverage over the default batch", () => {
  const groundedIn = (s: Scenario): Set<number> => {
    const out = new Set<number>();
    const texts = [
      s.text,
      ...(s.steps ?? []).flatMap((x) =>
        x.kind === "clarify" ? [x.answer] : [],
      ),
    ];
    for (const t of texts)
      for (const a of extractGroundedAmounts(t)) out.add(a);
    return out;
  };
  const payments = (s: Scenario) =>
    s.llm.mode === "script"
      ? s.llm.proposals.flatMap((p) =>
          p.kind === "propose_payment" ? [p] : [],
        )
      : [];

  it("exercises every dimension the oracles care about", () => {
    const has = (pred: (s: Scenario) => boolean): boolean => batch.some(pred);
    expect(has((s) => s.idempotencyKey !== undefined)).toBe(true);
    expect(has((s) => s.idempotencyKey === undefined)).toBe(true);
    expect(
      has((s) => (s.steps ?? []).some((x) => "as" in x && x.as !== undefined)),
    ).toBe(true);
    expect(has((s) => (s.steps ?? []).some((x) => x.kind === "approve"))).toBe(
      true,
    );
    expect(has((s) => (s.steps ?? []).some((x) => x.kind === "submit"))).toBe(
      true,
    );
    expect(has((s) => s.agentCore?.runStatus === "completed")).toBe(true);
    expect(
      has((s) => payments(s).some((p) => !groundedIn(s).has(p.amount))),
    ).toBe(true);
    expect(
      has((s) =>
        payments(s).some((p) => p.currency === "CHF" || p.currency === "JPY"),
      ),
    ).toBe(true);
    expect(
      has((s) =>
        payments(s).some(
          (p) => p.amount > (s.policy?.maxHardLimitAmount ?? 500_000),
        ),
      ),
    ).toBe(true);
  });
});
