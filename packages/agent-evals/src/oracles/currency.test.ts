import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY_CONFIG } from "@apo/agent-orchestrator";
import { currency } from "./currency.js";
import { exchange, observation, startCall } from "./observation-fixture.js";

function call(cur: string, amount: number) {
  return startCall({
    request: {
      amount,
      currency: cur,
      merchantId: "acme",
      paymentMethodToken: "pm",
    },
  });
}

const linked = [exchange({ coreCallIndexes: [0] })];

describe("I6 currency", () => {
  it("catches a currency outside the default allowlist", () => {
    const r = currency(
      observation({ coreCalls: [call("JPY", 12000)], http: linked }),
    );
    expect(r.violations).toHaveLength(1);
  });

  it("catches an allowlist the resolver rejects (config subject)", () => {
    const r = currency(
      observation({
        policy: { ...DEFAULT_POLICY_CONFIG, allowedCurrencies: ["JPY"] },
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
  });

  it("catches a zero amount", () => {
    const r = currency(
      observation({ coreCalls: [call("USD", 0)], http: linked }),
    );
    expect(r.violations).toHaveLength(1);
  });

  it("passes USD 12000", () => {
    const r = currency(
      observation({ coreCalls: [call("USD", 12000)], http: linked }),
    );
    expect(r.subjects).toBe(2);
    expect(r.violations).toEqual([]);
  });
});
