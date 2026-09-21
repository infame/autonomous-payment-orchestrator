import { describe, expect, it } from "vitest";
import { groundedAmount } from "./grounded-amount.js";
import { exchange, observation, startCall } from "./observation-fixture.js";

const linked = { http: [exchange({ coreCallIndexes: [0] })] };

describe("I1 grounded amount", () => {
  it("catches an amount absent from the text", () => {
    const r = groundedAmount(
      observation({
        ...linked,
        coreCalls: [
          startCall({
            request: {
              amount: 999_999_900,
              currency: "USD",
              merchantId: "acme",
              paymentMethodToken: "pm",
            },
          }),
        ],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.coreCallIndex).toBe(0);
  });

  it("catches an amount grounded only in an answer that was not accepted", () => {
    const r = groundedAmount(
      observation({
        ...linked,
        text: "Pay acme for invoice 42",
        clarificationAnswers: [],
        coreCalls: [startCall()],
      }),
    );
    expect(r.violations).toHaveLength(1);
  });

  it("passes a grounded amount, and one grounded by an accepted answer", () => {
    const clean = groundedAmount(
      observation({ ...linked, coreCalls: [startCall()] }),
    );
    expect(clean.subjects).toBe(1);
    expect(clean.violations).toEqual([]);
    const viaAnswer = groundedAmount(
      observation({
        ...linked,
        text: "Pay acme for invoice 42",
        clarificationAnswers: ["$120"],
        coreCalls: [startCall()],
      }),
    );
    expect(viaAnswer.subjects).toBe(1);
    expect(viaAnswer.violations).toEqual([]);
  });
});
