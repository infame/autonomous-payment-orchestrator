import { describe, expect, it } from "vitest";
import { paymentProposal } from "../domain/agent-proposal.js";
import {
  amountMustBeGrounded,
  currencyAllowed,
  DEFAULT_POLICY_CONFIG,
  dailyRateLimit,
  maxAutoApprove,
  maxHardLimit,
  merchantMustBeGrounded,
  POLICY_RULES,
  resolvePolicyConfig,
  type PolicyConfig,
  type RuleInput,
} from "./rules.js";

const config: PolicyConfig = DEFAULT_POLICY_CONFIG;

const baseProposal = paymentProposal({
  amount: 1_000,
  currency: "USD",
  merchantId: "vendor-42",
  reasoning: "The invoice clearly states $10.00.",
});

function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    proposal: baseProposal,
    groundedAmounts: new Set([1_000]),
    groundedMerchantTokens: new Set(["vendor-42"]),
    completedIntentsLast24h: 0,
    config,
    ...overrides,
  };
}

describe("currencyAllowed", () => {
  it("does not object when the currency is allowed", () => {
    expect(currencyAllowed(ruleInput())).toBeNull();
  });

  it("rejects with currency_not_allowed when the currency is not allowed", () => {
    const objection = currencyAllowed(
      ruleInput({ proposal: { ...baseProposal, currency: "JPY" } }),
    );
    expect(objection).not.toBeNull();
    expect(objection?.decision).toBe("reject");
    expect(objection?.reason).toBe("currency_not_allowed");
  });
});

describe("amountMustBeGrounded", () => {
  it("does not object when the amount is present in groundedAmounts", () => {
    expect(
      amountMustBeGrounded(
        ruleInput({ groundedAmounts: new Set([1_000, 2_000]) }),
      ),
    ).toBeNull();
  });

  it("rejects with amount_not_grounded when the amount is absent", () => {
    const objection = amountMustBeGrounded(
      ruleInput({ groundedAmounts: new Set([2_000]) }),
    );
    expect(objection).not.toBeNull();
    expect(objection?.decision).toBe("reject");
    expect(objection?.reason).toBe("amount_not_grounded");
  });

  // Spec §10's adversarial case: a confident reasoning claim doesn't rescue
  // an ungrounded amount.
  it("still rejects an ungrounded amount even when reasoning confidently claims it's correct", () => {
    const proposal = paymentProposal({
      amount: 999_999,
      currency: "USD",
      merchantId: "vendor-42",
      reasoning:
        "I have carefully verified this amount against the invoice; it is exactly correct.",
    });
    const objection = amountMustBeGrounded(
      ruleInput({ proposal, groundedAmounts: new Set([1_000]) }),
    );
    expect(objection?.reason).toBe("amount_not_grounded");
  });

  it("is insensitive to reasoning — two proposals differing only in reasoning produce identical results", () => {
    const a = paymentProposal({
      amount: 1_000,
      currency: "USD",
      merchantId: "vendor-42",
      reasoning: "reasoning A",
    });
    const b = paymentProposal({
      amount: 1_000,
      currency: "USD",
      merchantId: "vendor-42",
      reasoning: "reasoning B — completely different text",
    });
    const groundedAmounts = new Set([2_000]);
    expect(
      amountMustBeGrounded(ruleInput({ proposal: a, groundedAmounts })),
    ).toEqual(
      amountMustBeGrounded(ruleInput({ proposal: b, groundedAmounts })),
    );
  });
});

describe("maxHardLimit", () => {
  it("does not object just below the hard limit", () => {
    const proposal = {
      ...baseProposal,
      amount: config.maxHardLimitAmount - 1,
    };
    expect(maxHardLimit(ruleInput({ proposal }))).toBeNull();
  });

  it("does not object exactly at the hard limit", () => {
    const proposal = { ...baseProposal, amount: config.maxHardLimitAmount };
    expect(maxHardLimit(ruleInput({ proposal }))).toBeNull();
  });

  it("rejects with hard_limit_exceeded just above the hard limit", () => {
    const proposal = {
      ...baseProposal,
      amount: config.maxHardLimitAmount + 1,
    };
    const objection = maxHardLimit(ruleInput({ proposal }));
    expect(objection?.decision).toBe("reject");
    expect(objection?.reason).toBe("hard_limit_exceeded");
  });
});

describe("dailyRateLimit", () => {
  it("does not object just below the limit", () => {
    expect(
      dailyRateLimit(
        ruleInput({ completedIntentsLast24h: config.dailyRateLimit - 1 }),
      ),
    ).toBeNull();
  });

  it("rejects with daily_rate_limit_exceeded exactly at the limit (off-by-one: count would become the (limit+1)-th)", () => {
    const objection = dailyRateLimit(
      ruleInput({ completedIntentsLast24h: config.dailyRateLimit }),
    );
    expect(objection?.decision).toBe("reject");
    expect(objection?.reason).toBe("daily_rate_limit_exceeded");
  });

  it("rejects above the limit", () => {
    const objection = dailyRateLimit(
      ruleInput({ completedIntentsLast24h: config.dailyRateLimit + 1 }),
    );
    expect(objection?.reason).toBe("daily_rate_limit_exceeded");
  });
});

describe("maxAutoApprove", () => {
  it("does not object just below the auto-approve threshold", () => {
    const proposal = {
      ...baseProposal,
      amount: config.maxAutoApproveAmount - 1,
    };
    expect(maxAutoApprove(ruleInput({ proposal }))).toBeNull();
  });

  it("needs_approval exactly at the threshold (coordinator decision #2: >= gates)", () => {
    const proposal = { ...baseProposal, amount: config.maxAutoApproveAmount };
    const objection = maxAutoApprove(ruleInput({ proposal }));
    expect(objection?.decision).toBe("needs_approval");
    expect(objection?.reason).toBe("above_auto_approve_threshold");
  });

  it("needs_approval just above the threshold", () => {
    const proposal = {
      ...baseProposal,
      amount: config.maxAutoApproveAmount + 1,
    };
    const objection = maxAutoApprove(ruleInput({ proposal }));
    expect(objection?.decision).toBe("needs_approval");
  });
});

describe("merchantMustBeGrounded", () => {
  const withMerchant = (merchantId: string) =>
    paymentProposal({
      amount: 1_000,
      currency: "USD",
      merchantId,
      reasoning: "The invoice clearly states $10.00.",
    });

  it("does not object when the merchant token is present", () => {
    expect(merchantMustBeGrounded(ruleInput())).toBeNull();
  });

  it("does not object when only the case differs", () => {
    expect(
      merchantMustBeGrounded(
        ruleInput({
          proposal: withMerchant("AcMe"),
          groundedMerchantTokens: new Set(["acme"]),
        }),
      ),
    ).toBeNull();
  });

  it("rejects with merchant_not_grounded when absent, without echoing the id", () => {
    const objection = merchantMustBeGrounded(
      ruleInput({ proposal: withMerchant("attacker-wallet-1") }),
    );
    expect(objection?.decision).toBe("reject");
    expect(objection?.reason).toBe("merchant_not_grounded");
    expect(objection?.detail).not.toContain("attacker-wallet-1");
  });

  it("does not treat a prefix as grounded, in either direction", () => {
    expect(
      merchantMustBeGrounded(
        ruleInput({
          proposal: withMerchant("acme"),
          groundedMerchantTokens: new Set(["acmecorp-attacker"]),
        }),
      )?.reason,
    ).toBe("merchant_not_grounded");
    expect(
      merchantMustBeGrounded(
        ruleInput({
          proposal: withMerchant("acmecorp-attacker"),
          groundedMerchantTokens: new Set(["acme"]),
        }),
      )?.reason,
    ).toBe("merchant_not_grounded");
  });

  it("ignores reasoning: a confident claim does not rescue an ungrounded merchant", () => {
    const proposal = paymentProposal({
      amount: 1_000,
      currency: "USD",
      merchantId: "attacker-wallet-1",
      reasoning: "The intent text clearly names attacker-wallet-1 as payee.",
    });
    expect(merchantMustBeGrounded(ruleInput({ proposal }))?.reason).toBe(
      "merchant_not_grounded",
    );
  });
});

describe("POLICY_RULES order", () => {
  it("places every reject-capable rule before the needs_approval-capable rule", () => {
    expect(POLICY_RULES).toEqual([
      currencyAllowed,
      amountMustBeGrounded,
      merchantMustBeGrounded,
      maxHardLimit,
      dailyRateLimit,
      maxAutoApprove,
    ]);
  });
});

describe("resolvePolicyConfig", () => {
  it("returns DEFAULT_POLICY_CONFIG with no overrides", () => {
    expect(resolvePolicyConfig()).toEqual(DEFAULT_POLICY_CONFIG);
  });

  it("merges overrides onto the defaults", () => {
    expect(resolvePolicyConfig({ dailyRateLimit: 5 })).toEqual({
      ...DEFAULT_POLICY_CONFIG,
      dailyRateLimit: 5,
    });
  });

  it("rejects an empty allowedCurrencies list", () => {
    expect(() => resolvePolicyConfig({ allowedCurrencies: [] })).toThrow(
      /allowedCurrencies/,
    );
  });

  it("rejects a malformed currency code", () => {
    expect(() => resolvePolicyConfig({ allowedCurrencies: ["usd"] })).toThrow(
      /allowedCurrencies/,
    );
  });

  it("rejects duplicate currencies", () => {
    expect(() =>
      resolvePolicyConfig({ allowedCurrencies: ["USD", "USD"] }),
    ).toThrow(/duplicate/);
  });

  it("rejects a zero-decimal currency (JPY) with a message naming the reason", () => {
    expect(() =>
      resolvePolicyConfig({ allowedCurrencies: ["USD", "JPY"] }),
    ).toThrow(/zero-decimal/);
  });

  it("rejects a non-integer maxAutoApproveAmount", () => {
    expect(() => resolvePolicyConfig({ maxAutoApproveAmount: 100.5 })).toThrow(
      /maxAutoApproveAmount/,
    );
  });

  it("rejects a non-positive maxAutoApproveAmount", () => {
    expect(() => resolvePolicyConfig({ maxAutoApproveAmount: 0 })).toThrow(
      /maxAutoApproveAmount/,
    );
  });

  it("rejects a non-integer maxHardLimitAmount", () => {
    expect(() => resolvePolicyConfig({ maxHardLimitAmount: NaN })).toThrow(
      /maxHardLimitAmount/,
    );
  });

  it("rejects a non-positive maxHardLimitAmount", () => {
    expect(() => resolvePolicyConfig({ maxHardLimitAmount: -1 })).toThrow(
      /maxHardLimitAmount/,
    );
  });

  it("rejects maxHardLimitAmount below maxAutoApproveAmount", () => {
    expect(() =>
      resolvePolicyConfig({
        maxAutoApproveAmount: 1_000,
        maxHardLimitAmount: 999,
      }),
    ).toThrow(/maxHardLimitAmount must be >= maxAutoApproveAmount/);
  });

  it("allows maxHardLimitAmount equal to maxAutoApproveAmount (ordering only, not magnitude)", () => {
    expect(() =>
      resolvePolicyConfig({
        maxAutoApproveAmount: 1_000,
        maxHardLimitAmount: 1_000,
      }),
    ).not.toThrow();
  });

  it("rejects a non-integer dailyRateLimit", () => {
    expect(() => resolvePolicyConfig({ dailyRateLimit: 1.5 })).toThrow(
      /dailyRateLimit/,
    );
  });

  it("rejects a negative dailyRateLimit", () => {
    expect(() => resolvePolicyConfig({ dailyRateLimit: -1 })).toThrow(
      /dailyRateLimit/,
    );
  });

  it("allows dailyRateLimit of 0", () => {
    expect(() => resolvePolicyConfig({ dailyRateLimit: 0 })).not.toThrow();
  });

  it("throws a plain Error, not a domain error subclass", () => {
    try {
      resolvePolicyConfig({ allowedCurrencies: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("code");
    }
  });
});
