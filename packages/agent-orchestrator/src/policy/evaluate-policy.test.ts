import { describe, expect, it } from "vitest";
import { paymentProposal } from "../domain/agent-proposal.js";
import { evaluatePolicy, type PolicyContext } from "./evaluate-policy.js";
import { DEFAULT_POLICY_CONFIG } from "./rules.js";

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    intentText: "Pay vendor-42 $10.00 for invoice #123.",
    clarificationAnswer: null,
    completedIntentsLast24h: 0,
    config: DEFAULT_POLICY_CONFIG,
    ...overrides,
  };
}

const compliantProposal = paymentProposal({
  amount: 1_000,
  currency: "USD",
  merchantId: "vendor-42",
  reasoning: "The invoice states $10.00.",
});

describe("evaluatePolicy", () => {
  it("allows a fully compliant proposal", () => {
    expect(evaluatePolicy(compliantProposal, context())).toEqual({
      decision: "allow",
    });
  });

  it("grounds amounts from intentText alone when clarificationAnswer is null", () => {
    const verdict = evaluatePolicy(
      compliantProposal,
      context({ intentText: "Pay $10.00.", clarificationAnswer: null }),
    );
    expect(verdict.decision).toBe("allow");
  });

  it("grounds amounts from both intentText and a non-null clarificationAnswer", () => {
    const proposal = paymentProposal({
      amount: 2_000,
      currency: "USD",
      merchantId: "vendor-42",
      reasoning: "The customer confirmed $20.00.",
    });
    const verdict = evaluatePolicy(
      proposal,
      context({
        intentText: "Pay vendor-42, amount unclear from the invoice.",
        clarificationAnswer: "It's $20.00.",
      }),
    );
    expect(verdict.decision).toBe("allow");
  });

  it("rejects for amount_not_grounded, not hard_limit_exceeded, when both apply (precedence)", () => {
    const proposal = paymentProposal({
      amount: 999_999,
      currency: "USD",
      merchantId: "vendor-42",
      reasoning: "Definitely correct.",
    });
    const verdict = evaluatePolicy(
      proposal,
      context({ intentText: "No amounts mentioned here." }),
    );
    expect(verdict.decision).toBe("reject");
    expect(verdict.decision === "reject" && verdict.reason).toBe(
      "amount_not_grounded",
    );
  });

  it("rejects for currency_not_allowed first when both wrong currency and over-limit apply", () => {
    const proposal = {
      ...compliantProposal,
      currency: "JPY",
      amount: 999_999,
    };
    const verdict = evaluatePolicy(
      proposal,
      context({ intentText: "No amounts mentioned here." }),
    );
    expect(verdict.decision).toBe("reject");
    expect(verdict.decision === "reject" && verdict.reason).toBe(
      "currency_not_allowed",
    );
  });

  it("is pure: two identical calls produce deep-equal verdicts and neither argument is mutated", () => {
    const ctx = context();
    const proposalCopy = { ...compliantProposal };
    const ctxCopy = { ...ctx };

    const verdict1 = evaluatePolicy(compliantProposal, ctx);
    const verdict2 = evaluatePolicy(compliantProposal, ctx);

    expect(verdict1).toEqual(verdict2);
    expect(compliantProposal).toEqual(proposalCopy);
    expect(ctx).toEqual(ctxCopy);
  });

  it("throws a plain Error, never returning a verdict, for a malformed config", () => {
    expect(() =>
      evaluatePolicy(
        compliantProposal,
        context({
          config: { ...DEFAULT_POLICY_CONFIG, allowedCurrencies: [] },
        }),
      ),
    ).toThrow(Error);
  });

  it("a needs_approval verdict carries both reason and a non-empty detail", () => {
    const proposal = {
      ...compliantProposal,
      amount: DEFAULT_POLICY_CONFIG.maxAutoApproveAmount,
    };
    const verdict = evaluatePolicy(
      proposal,
      context({
        intentText: `Pay vendor-42 ${String(DEFAULT_POLICY_CONFIG.maxAutoApproveAmount / 100)}.`,
      }),
    );
    expect(verdict.decision).toBe("needs_approval");
    if (verdict.decision === "needs_approval") {
      expect(verdict.reason).toBe("above_auto_approve_threshold");
      expect(verdict.detail.length).toBeGreaterThan(0);
    }
  });

  // Spec §10 / §3.3 demo-scenario shape: an intent text with two plausible
  // amounts grounds both; picking the lower one (the "safe interpretation")
  // allows, while a third, invented amount rejects.
  describe("demo scenario: ambiguous amount, safe interpretation", () => {
    const intentText =
      "Pay vendor-42 for the invoice — it lists 100.00 or possibly 150.00 depending on the discount.";

    it("allows the lower of two plausible grounded amounts", () => {
      const safeProposal = paymentProposal({
        amount: 10_000,
        currency: "USD",
        merchantId: "vendor-42",
        reasoning: "Picking the lower amount to be safe: $100.00.",
      });
      const verdict = evaluatePolicy(safeProposal, context({ intentText }));
      expect(verdict.decision).toBe("allow");
    });

    it("rejects a third amount invented from nothing in the same text", () => {
      const inventedProposal = paymentProposal({
        amount: 20_000,
        currency: "USD",
        merchantId: "vendor-42",
        reasoning: "Rounding up to $200.00 to be safe.",
      });
      const verdict = evaluatePolicy(inventedProposal, context({ intentText }));
      expect(verdict.decision).toBe("reject");
      expect(verdict.decision === "reject" && verdict.reason).toBe(
        "amount_not_grounded",
      );
    });
  });
});
