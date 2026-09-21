import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY_CONFIG } from "@apo/agent-orchestrator";
import { rateLimit } from "./rate-limit.js";
import { observation, observedIntent, view } from "./observation-fixture.js";

function completed(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const v = view({ id: `intent_${i}`, status: "completed" });
    return observedIntent({ id: `intent_${i}`, views: [v], finalView: v });
  });
}

function withLimit(n: number, limit: number) {
  return observation({
    intents: completed(n),
    policy: { ...DEFAULT_POLICY_CONFIG, dailyRateLimit: limit },
  });
}

describe("I8 rate limit", () => {
  it("catches 3 completed intents against a limit of 2", () => {
    const r = rateLimit(withLimit(3, 2));
    expect(r.subjects).toBe(3);
    expect(r.violations).toHaveLength(1);
  });

  it("catches 1 completed intent against a limit of 0", () => {
    const r = rateLimit(withLimit(1, 0));
    expect(r.violations).toHaveLength(1);
  });

  it("passes exactly the limit", () => {
    const r = rateLimit(withLimit(2, 2));
    expect(r.subjects).toBe(2);
    expect(r.violations).toEqual([]);
  });
});
