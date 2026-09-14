import { describe, expect, it } from "vitest";
import { extractGroundedAmounts } from "../../policy/grounding.js";
import { mergeDirectives, parseDirectives } from "./directives.js";

describe("parseDirectives — outcome verbs, standalone and mid-prose", () => {
  it("sim.unavailable", () => {
    expect(parseDirectives("sim.unavailable").outcome).toEqual({
      kind: "unavailable",
    });
    expect(
      parseDirectives("Please simulate: sim.unavailable today.").outcome,
    ).toEqual({ kind: "unavailable" });
  });

  it("sim.decline defaults to unsupported_request", () => {
    expect(parseDirectives("sim.decline").outcome).toEqual({
      kind: "decline",
      slug: "unsupported_request",
    });
  });

  it("sim.decline.<slug> carries the slug", () => {
    expect(parseDirectives("sim.decline.fraud_suspected").outcome).toEqual({
      kind: "decline",
      slug: "fraud_suspected",
    });
    expect(
      parseDirectives("Pay this: sim.decline.fraud_suspected, thanks.").outcome,
    ).toEqual({ kind: "decline", slug: "fraud_suspected" });
  });

  it("sim.clarify defaults to amount", () => {
    expect(parseDirectives("sim.clarify").outcome).toEqual({
      kind: "clarify",
      slug: "amount",
    });
  });

  it("sim.clarify.<slug> carries the slug, mid-prose", () => {
    expect(
      parseDirectives("Unclear intent: sim.clarify.merchant here.").outcome,
    ).toEqual({ kind: "clarify", slug: "merchant" });
  });

  it("sim.amount.min / .max / .ungrounded", () => {
    expect(parseDirectives("sim.amount.min").outcome).toEqual({
      kind: "payment",
      selector: "min",
    });
    expect(parseDirectives("sim.amount.max").outcome).toEqual({
      kind: "payment",
      selector: "max",
    });
    expect(parseDirectives("sim.amount.ungrounded").outcome).toEqual({
      kind: "payment",
      selector: "ungrounded",
    });
  });

  it("punctuation immediately after a directive doesn't swallow it", () => {
    expect(parseDirectives("Use sim.decline, please.").outcome).toEqual({
      kind: "decline",
      slug: "unsupported_request",
    });
    expect(parseDirectives("(sim.amount.max)").outcome).toEqual({
      kind: "payment",
      selector: "max",
    });
    expect(parseDirectives("sim.unavailable!").outcome).toEqual({
      kind: "unavailable",
    });
  });
});

describe("parseDirectives — total, never throws, outcome: null", () => {
  it.each([
    "",
    "Pay vendor-42 for the invoice.",
    "sim.",
    "sim.nonsense",
    "sim.amount.blah",
    "SIM.DECLINE",
    "Sim.Decline",
    "simulate a payment please",
    "simple text with no directive",
  ])("returns outcome: null (never throws) for %j", (text) => {
    expect(() => parseDirectives(text)).not.toThrow();
    expect(parseDirectives(text).outcome).toBeNull();
    expect(parseDirectives(text).currency).toBeNull();
    expect(parseDirectives(text).merchantId).toBeNull();
  });
});

describe("parseDirectives — currency modifier", () => {
  it("valid uppercase code parses", () => {
    expect(parseDirectives("sim.currency.EUR").currency).toBe("EUR");
  });

  it("lowercase currency is ignored", () => {
    expect(parseDirectives("sim.currency.eur").currency).toBeNull();
  });

  it("wrong-length currency is ignored", () => {
    expect(parseDirectives("sim.currency.EU").currency).toBeNull();
    expect(parseDirectives("sim.currency.EURO").currency).toBeNull();
  });
});

describe("parseDirectives — merchant modifier", () => {
  it("valid id parses", () => {
    expect(parseDirectives("sim.merchant.vendor-42").merchantId).toBe(
      "vendor-42",
    );
  });

  it("oversized merchant id is ignored", () => {
    const oversized = "a".repeat(65);
    expect(parseDirectives(`sim.merchant.${oversized}`).merchantId).toBeNull();
  });
});

describe("parseDirectives — within-field outcome precedence", () => {
  it("unavailable beats decline, clarify, and amount", () => {
    const text =
      "sim.amount.min sim.clarify sim.decline sim.unavailable trailing text";
    expect(parseDirectives(text).outcome).toEqual({ kind: "unavailable" });
  });

  it("decline beats clarify and amount", () => {
    const text = "sim.amount.min sim.clarify sim.decline.fraud";
    expect(parseDirectives(text).outcome).toEqual({
      kind: "decline",
      slug: "fraud",
    });
  });

  it("clarify beats amount", () => {
    const text = "sim.amount.min sim.clarify.merchant";
    expect(parseDirectives(text).outcome).toEqual({
      kind: "clarify",
      slug: "merchant",
    });
  });
});

describe("mergeDirectives", () => {
  const payment = (
    selector: "min" | "max" | "ungrounded",
  ): ReturnType<typeof parseDirectives> => ({
    outcome: { kind: "payment", selector },
    currency: null,
    merchantId: null,
  });

  it("answer's outcome wins over text's when both are present", () => {
    const answer = parseDirectives("sim.decline.manipulation");
    const text = parseDirectives("sim.amount.min");
    expect(mergeDirectives(answer, text).outcome).toEqual({
      kind: "decline",
      slug: "manipulation",
    });
  });

  it("falls through to text's outcome when answer's is null", () => {
    const answer = parseDirectives("no directive here");
    const text = parseDirectives("sim.amount.max");
    expect(mergeDirectives(answer, text).outcome).toEqual({
      kind: "payment",
      selector: "max",
    });
  });

  it("currency and merchantId merge independently of outcome and each other", () => {
    const answer = parseDirectives("sim.currency.EUR");
    const text = parseDirectives("sim.amount.min sim.merchant.vendor-9");
    const merged = mergeDirectives(answer, text);
    expect(merged.outcome).toEqual({ kind: "payment", selector: "min" });
    expect(merged.currency).toBe("EUR");
    expect(merged.merchantId).toBe("vendor-9");
  });

  it("all-null answer and all-null text merge to all-null", () => {
    expect(mergeDirectives(parseDirectives(""), parseDirectives(""))).toEqual({
      outcome: null,
      currency: null,
      merchantId: null,
    });
  });

  it("is a pure field-by-field pick, not a deep merge (sanity check with helper)", () => {
    expect(mergeDirectives(payment("max"), payment("min")).outcome).toEqual({
      kind: "payment",
      selector: "max",
    });
  });
});

describe("regression: every directive string is amount-fabrication-free", () => {
  const DIRECTIVE_STRINGS = [
    "sim.unavailable",
    "sim.decline",
    "sim.decline.fraud_suspected",
    "sim.clarify",
    "sim.clarify.merchant",
    "sim.amount.min",
    "sim.amount.max",
    "sim.amount.ungrounded",
    "sim.currency.EUR",
  ];

  it.each(DIRECTIVE_STRINGS)(
    "%s alone grounds zero amounts via extractGroundedAmounts",
    (directive) => {
      expect(extractGroundedAmounts(directive).size).toBe(0);
    },
  );

  it("documented exception: sim.merchant.<digits> DOES ground an amount, because the merchant id itself contains digits extractGroundedAmounts can't distinguish from a real number", () => {
    expect(extractGroundedAmounts("sim.merchant.acct123").size).toBe(1);
    expect(extractGroundedAmounts("sim.merchant.vendor-42").size).toBe(1);
  });

  it("a merchant id with no digits does not ground any amount", () => {
    expect(extractGroundedAmounts("sim.merchant.demo_merchant").size).toBe(0);
  });
});
