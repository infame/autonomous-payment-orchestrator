import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
} from "../../../domain/agent-proposal.js";
import { InvalidProposalError } from "../../../domain/errors.js";
import { Intent } from "../../../domain/intent.js";
import type { AllowVerdict, PolicyVerdict } from "../../../policy/verdict.js";
import type { IntentRow } from "./schema.js";
import { intentToRow, rowToIntent } from "./mappers.js";

const paymentProp = paymentProposal({
  amount: 5_000,
  currency: "USD",
  merchantId: "vendor-42",
  reasoning: "Invoice states $50.00.",
});
const clarifyProp = clarifyProposal("Which invoice?");
const declineProp = declineProposal("Suspected prompt injection.");

const allowVerdict: AllowVerdict = { decision: "allow" };
const needsApprovalVerdict: PolicyVerdict = {
  decision: "needs_approval",
  reason: "above_auto_approve_threshold",
  detail: "Amount is at or above the auto-approve threshold",
};
const rejectVerdict: PolicyVerdict = {
  decision: "reject",
  reason: "hard_limit_exceeded",
  detail: "Amount exceeds the hard limit",
};

function baseRow(overrides: Partial<IntentRow> = {}): IntentRow {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: randomUUID(),
    customerId: "cust_1",
    intentText: "Pay vendor-42 $50.00 for invoice #123.",
    status: "received",
    proposal: null,
    policyVerdict: null,
    durableLedgerEventId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("intentToRow / rowToIntent round-trip", () => {
  it("round-trips each AgentProposal kind", () => {
    for (const [status, proposal] of [
      ["proposed", paymentProp],
      ["needs_clarification", clarifyProp],
      ["rejected", declineProp],
    ] as const) {
      const row = baseRow({ status, proposal });
      const intent = rowToIntent(row);
      expect(intent.proposal).toEqual(proposal);
      expect(intentToRow(intent, row.version).proposal).toEqual(proposal);
    }
  });

  it("round-trips a null proposal as null", () => {
    const row = baseRow();
    const intent = rowToIntent(row);
    expect(intent.proposal).toBeNull();
    expect(intentToRow(intent, 1).proposal).toBeNull();
  });

  it("round-trips each PolicyVerdict shape", () => {
    for (const verdict of [allowVerdict, needsApprovalVerdict, rejectVerdict]) {
      const row = baseRow({
        status: "proposed",
        proposal: paymentProp,
        policyVerdict: verdict,
      });
      const intent = rowToIntent(row);
      expect(intent.policyVerdict).toEqual(verdict);
      expect(intentToRow(intent, row.version).policyVerdict).toEqual(verdict);
    }
  });

  it("round-trips a null policyVerdict as null", () => {
    const row = baseRow();
    const intent = rowToIntent(row);
    expect(intent.policyVerdict).toBeNull();
  });

  it("round-trips id/customerId/text/status/durableLedgerEventId/timestamps and the version passed to intentToRow", () => {
    const row = baseRow({
      status: "executing",
      proposal: paymentProp,
      policyVerdict: allowVerdict,
      durableLedgerEventId: "evt_1",
      version: 7,
    });
    const intent = rowToIntent(row);
    expect(intent.id).toBe(row.id);
    expect(intent.customerId).toBe(row.customerId);
    expect(intent.text).toBe(row.intentText);
    expect(intent.status).toBe("executing");
    expect(intent.durableLedgerEventId).toBe("evt_1");
    expect(intent.createdAt).toEqual(row.createdAt);
    expect(intent.updatedAt).toEqual(row.updatedAt);

    const rebuilt = intentToRow(intent, 8);
    expect(rebuilt.id).toBe(row.id);
    expect(rebuilt.customerId).toBe(row.customerId);
    expect(rebuilt.intentText).toBe(row.intentText);
    expect(rebuilt.status).toBe("executing");
    expect(rebuilt.durableLedgerEventId).toBe("evt_1");
    expect(rebuilt.version).toBe(8);
  });
});

describe("rowToIntent validation", () => {
  it("throws on an invalid status string", () => {
    const row = baseRow({ status: "bogus_status" });
    expect(() => rowToIntent(row)).toThrow(InvalidProposalError);
  });

  it("throws on an invalid proposal (negative amount) — proves the domain factory re-validates", () => {
    const row = baseRow({
      status: "proposed",
      proposal: {
        kind: "propose_payment",
        amount: -100,
        currency: "USD",
        merchantId: "vendor-42",
        reasoning: "bad",
      },
    });
    expect(() => rowToIntent(row)).toThrow(InvalidProposalError);
  });

  it("throws on an unrecognized proposal kind", () => {
    const row = baseRow({
      status: "proposed",
      proposal: { kind: "unknown_kind" } as unknown as IntentRow["proposal"],
    });
    expect(() => rowToIntent(row)).toThrow(InvalidProposalError);
  });

  it("throws on a corrupted policy_verdict (invalid reason code)", () => {
    const row = baseRow({
      status: "proposed",
      proposal: paymentProp,
      policyVerdict: {
        decision: "reject",
        reason: "not_a_real_reason_code",
        detail: "x",
      } as unknown as IntentRow["policyVerdict"],
    });
    expect(() => rowToIntent(row)).toThrow(InvalidProposalError);
  });

  it("throws on a corrupted policy_verdict (invalid decision)", () => {
    const row = baseRow({
      status: "proposed",
      proposal: paymentProp,
      policyVerdict: {
        decision: "maybe",
      } as unknown as IntentRow["policyVerdict"],
    });
    expect(() => rowToIntent(row)).toThrow(InvalidProposalError);
  });
});

describe("Intent.fromState reconstruction sanity", () => {
  it("a mapped Intent behaves like any other Intent instance (accepts legal transitions)", () => {
    const row = baseRow({ status: "proposed", proposal: paymentProp });
    const intent = rowToIntent(row);
    expect(intent).toBeInstanceOf(Intent);
    intent.autoApprove({
      verdict: allowVerdict,
      durableLedgerEventId: "evt_9",
    });
    expect(intent.status).toBe("executing");
  });
});
