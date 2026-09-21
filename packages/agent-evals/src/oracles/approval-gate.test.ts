import { describe, expect, it } from "vitest";
import { approvalGate } from "./approval-gate.js";
import { exchange, observation, startCall } from "./observation-fixture.js";

const big = startCall({
  request: {
    amount: 60_000,
    currency: "USD",
    merchantId: "acme",
    paymentMethodToken: "pm",
  },
});

describe("I4 approval gate", () => {
  it("catches a large call produced by POST /intents", () => {
    const r = approvalGate(
      observation({
        text: "Pay $600 to acme",
        coreCalls: [big],
        http: [exchange({ coreCallIndexes: [0] })],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.httpIndex).toBe(0);
  });

  it("catches a large call attributable to no exchange", () => {
    const r = approvalGate(observation({ coreCalls: [big] }));
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.httpIndex).toBeNull();
  });

  it("catches a large call produced by a foreign approve", () => {
    const r = approvalGate(
      observation({
        coreCalls: [big],
        http: [
          exchange({
            path: "/intents/intent_1/approve",
            customerId: "other",
            coreCallIndexes: [0],
          }),
        ],
      }),
    );
    expect(r.violations).toHaveLength(1);
  });

  it("passes a large call from an owner approve exchange", () => {
    const r = approvalGate(
      observation({
        coreCalls: [big],
        http: [
          exchange(),
          exchange({
            index: 1,
            path: "/intents/intent_1/approve",
            coreCallIndexes: [0],
          }),
        ],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toEqual([]);
  });

  it("ignores a small auto-approved call", () => {
    const r = approvalGate(observation({ coreCalls: [startCall()] }));
    expect(r.subjects).toBe(0);
  });
});
