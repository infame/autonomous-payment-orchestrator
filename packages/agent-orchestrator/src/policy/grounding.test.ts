import { describe, expect, it } from "vitest";
import { extractGroundedAmounts } from "./grounding.js";

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
