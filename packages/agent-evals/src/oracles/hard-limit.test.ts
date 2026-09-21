import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY_CONFIG } from "@apo/agent-orchestrator";
import { hardLimit } from "./hard-limit.js";
import { observation, startCall } from "./observation-fixture.js";

function withAmount(amount: number) {
  return observation({
    coreCalls: [
      startCall({
        request: {
          amount,
          currency: "USD",
          merchantId: "acme",
          paymentMethodToken: "pm",
        },
      }),
    ],
  });
}

describe("I2 hard limit", () => {
  it("catches limit + 1", () => {
    const r = hardLimit(
      withAmount(DEFAULT_POLICY_CONFIG.maxHardLimitAmount + 1),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
  });

  it("passes exactly the limit", () => {
    const r = hardLimit(withAmount(DEFAULT_POLICY_CONFIG.maxHardLimitAmount));
    expect(r.subjects).toBe(1);
    expect(r.violations).toEqual([]);
  });
});
