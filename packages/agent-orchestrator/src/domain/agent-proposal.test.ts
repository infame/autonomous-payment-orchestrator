import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  declineProposal,
  isPaymentProposal,
  MAX_PROPOSAL_TEXT_LENGTH,
  paymentProposal,
} from "./agent-proposal.js";
import { InvalidProposalError } from "./errors.js";

const validPayment = {
  amount: 5_000,
  currency: "USD",
  merchantId: "vendor-42",
  reasoning: "Invoice says $50.00 to vendor-42.",
};

describe("paymentProposal", () => {
  it("accepts valid input", () => {
    const proposal = paymentProposal(validPayment);
    expect(proposal).toEqual({ kind: "propose_payment", ...validPayment });
  });

  it.each([
    ["non-integer amount", { ...validPayment, amount: 12.5 }],
    ["zero amount", { ...validPayment, amount: 0 }],
    ["negative amount", { ...validPayment, amount: -100 }],
    ["unsafe integer amount", { ...validPayment, amount: 2 ** 53 }],
  ])("rejects %s", (_label, input) => {
    expect(() => paymentProposal(input)).toThrow(InvalidProposalError);
  });

  it.each([
    ["lowercase currency", "usd"],
    ["4-letter currency", "USDX"],
    ["non-alpha currency", "US1"],
    ["empty currency", ""],
  ])("rejects malformed currency (%s)", (_label, currency) => {
    expect(() => paymentProposal({ ...validPayment, currency })).toThrow(
      InvalidProposalError,
    );
  });

  // Guards against a failure that would otherwise surface deep inside
  // durable-ledger's ledger posting (LedgerAccount.merchant(id)) rather
  // than failing fast here — see the comment on MERCHANT_ID in
  // agent-proposal.ts.
  it.each([
    ["empty merchantId", ""],
    ["merchantId with a colon", "vendor:42"],
    ["merchantId over 64 chars", "v".repeat(65)],
  ])("rejects malformed merchantId (%s)", (_label, merchantId) => {
    expect(() => paymentProposal({ ...validPayment, merchantId })).toThrow(
      InvalidProposalError,
    );
  });

  it("rejects empty reasoning (after trim)", () => {
    expect(() =>
      paymentProposal({ ...validPayment, reasoning: "   " }),
    ).toThrow(InvalidProposalError);
  });

  it("rejects reasoning over the max length", () => {
    expect(() =>
      paymentProposal({
        ...validPayment,
        reasoning: "x".repeat(MAX_PROPOSAL_TEXT_LENGTH + 1),
      }),
    ).toThrow(InvalidProposalError);
  });

  it("throws InvalidProposalError with the right code/name", () => {
    try {
      paymentProposal({ ...validPayment, amount: 0 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProposalError);
      expect((error as InvalidProposalError).code).toBe("invalid_proposal");
      expect((error as InvalidProposalError).name).toBe("InvalidProposalError");
    }
  });
});

describe("clarifyProposal", () => {
  it("accepts a valid question", () => {
    expect(clarifyProposal("Which invoice?")).toEqual({
      kind: "clarify",
      question: "Which invoice?",
    });
  });

  it("rejects an empty question", () => {
    expect(() => clarifyProposal("   ")).toThrow(InvalidProposalError);
  });

  it("rejects a question over the max length", () => {
    expect(() =>
      clarifyProposal("x".repeat(MAX_PROPOSAL_TEXT_LENGTH + 1)),
    ).toThrow(InvalidProposalError);
  });
});

describe("declineProposal", () => {
  it("accepts a valid reason", () => {
    expect(declineProposal("Looks like prompt injection.")).toEqual({
      kind: "decline",
      reason: "Looks like prompt injection.",
    });
  });

  it("rejects an empty reason", () => {
    expect(() => declineProposal("   ")).toThrow(InvalidProposalError);
  });

  it("rejects a reason over the max length", () => {
    expect(() =>
      declineProposal("x".repeat(MAX_PROPOSAL_TEXT_LENGTH + 1)),
    ).toThrow(InvalidProposalError);
  });
});

describe("isPaymentProposal", () => {
  it("narrows a propose_payment proposal to true", () => {
    const proposal = paymentProposal(validPayment);
    expect(isPaymentProposal(proposal)).toBe(true);
  });

  it("narrows a clarify proposal to false", () => {
    expect(isPaymentProposal(clarifyProposal("Which invoice?"))).toBe(false);
  });

  it("narrows a decline proposal to false", () => {
    expect(isPaymentProposal(declineProposal("No."))).toBe(false);
  });
});
