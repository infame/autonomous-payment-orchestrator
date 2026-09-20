import { describe, expect, it } from "vitest";
import {
  extractGroundedAmounts,
  extractGroundedMerchantTokens,
} from "./grounding.js";

function grounded(text: string): number[] {
  return [...extractGroundedAmounts(text)].sort((a, b) => a - b);
}

describe("extractGroundedAmounts", () => {
  it("normalises a plain integer to minor units", () => {
    expect(grounded("1200")).toEqual([120_000]);
  });

  it("normalises a decimal amount to minor units", () => {
    expect(grounded("1200.50")).toEqual([120_050]);
  });

  it("pads a single fraction digit", () => {
    expect(grounded("1200.5")).toEqual([120_050]);
  });

  it("normalises a thousands-grouped amount", () => {
    expect(grounded("1,200.50")).toEqual([120_050]);
  });

  it("extracts multiple numbers from one text", () => {
    expect(grounded("Pay 100 or 200 total, whichever is lower.")).toEqual([
      10_000, 20_000,
    ]);
  });

  it("returns an empty set for text with no digits", () => {
    expect(grounded("Pay the vendor for the invoice.")).toEqual([]);
  });

  it("skips a malformed thousands-grouping rather than guessing", () => {
    expect(grounded("1,20")).toEqual([]);
  });

  it("skips a malformed thousands-grouping mixed with a valid amount", () => {
    expect(grounded("1,20 or 1,200.50")).toEqual([120_050]);
  });

  it("skips an amount with more than 2 fraction digits", () => {
    expect(grounded("1200.500")).toEqual([]);
  });

  it("is not broken by currency symbols and surrounding text", () => {
    expect(grounded("$1200 due, ref#99")).toEqual([9_900, 120_000]);
  });

  it("skips an absurdly large digit run (not a safe integer once scaled)", () => {
    expect(grounded("99999999999999999999")).toEqual([]);
  });

  // Documented limitation: a fabrication guard, not a correctness guard —
  // a date-like string in text WILL ground spurious amounts.
  it("grounds spurious amounts from a date-like string (documented limitation)", () => {
    expect(grounded("Invoice dated 2026-09-14")).toEqual([
      9 * 100,
      14 * 100,
      2_026 * 100,
    ]);
  });

  // Documented limitation: European "1.200,50" formatting is NOT supported
  // in v1. It isn't simply ignored either — "1.200" is parsed as a
  // (skipped) 3-fraction-digit amount and "50" is separately grounded as
  // 50.00, an incorrect fragment, not the intended 1200.50.
  it("does not support European 1.200,50 formatting", () => {
    expect(grounded("1.200,50")).toEqual([50 * 100]);
  });
});

describe("extractGroundedMerchantTokens", () => {
  const tokens = (text: string): string[] =>
    [...extractGroundedMerchantTokens(text)].sort();

  it("lower-cases tokens", () => {
    expect(tokens("Pay AcMe")).toEqual(["acme", "pay"]);
  });

  it("keeps - and _ token-internal", () => {
    const set = extractGroundedMerchantTokens("Pay vendor-42 or demo_merchant");
    expect(set.has("vendor-42")).toBe(true);
    expect(set.has("demo_merchant")).toBe(true);
  });

  it("splits on punctuation", () => {
    const set = extractGroundedMerchantTokens("acme, inc.");
    expect(set.has("acme")).toBe(true);
    expect(set.has("inc")).toBe(true);
  });

  it("does not ground acme from acmecorp-attacker", () => {
    expect(extractGroundedMerchantTokens("acmecorp-attacker").has("acme")).toBe(
      false,
    );
  });

  it("does not ground acmecorp-attacker from 'pay acme'", () => {
    expect(
      extractGroundedMerchantTokens("pay acme").has("acmecorp-attacker"),
    ).toBe(false);
  });

  it("drops digit-only tokens (amounts and reference numbers)", () => {
    const set = extractGroundedMerchantTokens(
      "Pay $120 to acme for invoice 42",
    );
    expect(set.has("acme")).toBe(true);
    expect(set.has("120")).toBe(false);
    expect(set.has("42")).toBe(false);
  });

  it("drops tokens with no letter", () => {
    const set = extractGroundedMerchantTokens("Pay the vendor - $50.00");
    expect(set.has("-")).toBe(false);
    expect(set.has("_")).toBe(false);
    expect(set.has("--")).toBe(false);
    expect(set.has("vendor")).toBe(true);
  });

  it("keeps a token that mixes letters, digits and hyphens", () => {
    expect(
      extractGroundedMerchantTokens("Pay vendor-42").has("vendor-42"),
    ).toBe(true);
  });

  it("self-grounds a sim.merchant directive id", () => {
    expect(
      extractGroundedMerchantTokens("Pay $5 sim.merchant.vendor-42").has(
        "vendor-42",
      ),
    ).toBe(true);
  });

  it("is total: empty, punctuation-only and huge inputs never throw", () => {
    expect(extractGroundedMerchantTokens("").size).toBe(0);
    expect(extractGroundedMerchantTokens("!?.,;:$#@ \n\t").size).toBe(0);
    expect(() =>
      extractGroundedMerchantTokens("a-b_c ".repeat(2_000)),
    ).not.toThrow();
  });
});
