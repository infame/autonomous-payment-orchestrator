import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
} from "./agent-proposal.js";
import { InvalidIntentError, InvalidIntentStateError } from "./errors.js";
import type { IntentProps, IntentStatus } from "./intent.js";
import {
  Intent,
  TERMINAL_INTENT_STATUSES,
  MAX_INTENT_TEXT_LENGTH,
  MAX_CLARIFICATION_ANSWER_LENGTH,
} from "./intent.js";
import type {
  AllowVerdict,
  NeedsApprovalVerdict,
  RejectVerdict,
} from "../policy/verdict.js";

const proposal = paymentProposal({
  amount: 5_000,
  currency: "USD",
  merchantId: "vendor-42",
  reasoning: "Invoice states $50.00.",
});

const allowVerdict: AllowVerdict = { decision: "allow" };
const needsApprovalVerdict: NeedsApprovalVerdict = {
  decision: "needs_approval",
  reason: "above_auto_approve_threshold",
  detail: "Amount is at or above the auto-approve threshold",
};
const rejectVerdict: RejectVerdict = {
  decision: "reject",
  reason: "hard_limit_exceeded",
  detail: "Amount exceeds the hard limit",
};

function submit(now?: Date): Intent {
  return Intent.submit({
    id: "intent_1",
    customerId: "cust_1",
    text: "Pay vendor-42 $50.00 for invoice #123.",
    ...(now !== undefined ? { now } : {}),
  });
}

/** Drives a fresh intent through the state machine to `status`, using one representative path for statuses reachable multiple ways. */
function intentAt(status: IntentStatus): Intent {
  const intent = submit();
  if (status === "received") return intent;
  if (status === "needs_clarification") {
    intent.clarify(clarifyProposal("Which invoice?"));
    return intent;
  }
  if (status === "proposed") {
    intent.propose(proposal);
    return intent;
  }
  if (status === "needs_approval") {
    intent.propose(proposal);
    intent.requireApproval(needsApprovalVerdict);
    return intent;
  }
  if (status === "rejected") {
    intent.propose(proposal);
    intent.rejectByPolicy(rejectVerdict);
    return intent;
  }
  if (status === "executing") {
    intent.propose(proposal);
    intent.autoApprove({
      verdict: allowVerdict,
      durableLedgerEventId: "evt_1",
    });
    return intent;
  }
  if (status === "completed") {
    intent.propose(proposal);
    intent.autoApprove({
      verdict: allowVerdict,
      durableLedgerEventId: "evt_1",
    });
    intent.complete();
    return intent;
  }
  if (status === "failed") {
    intent.propose(proposal);
    intent.autoApprove({
      verdict: allowVerdict,
      durableLedgerEventId: "evt_1",
    });
    intent.fail();
    return intent;
  }
  // needs_review
  intent.propose(proposal);
  intent.autoApprove({ verdict: allowVerdict, durableLedgerEventId: "evt_1" });
  intent.flagForReview();
  return intent;
}

const ALL_STATUSES: readonly IntentStatus[] = [
  "received",
  "needs_clarification",
  "proposed",
  "needs_approval",
  "rejected",
  "executing",
  "completed",
  "failed",
  "needs_review",
];

describe("Intent.submit", () => {
  it("creates a fresh intent in the received state", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const intent = submit(now);
    expect(intent.status).toBe("received");
    expect(intent.id).toBe("intent_1");
    expect(intent.customerId).toBe("cust_1");
    expect(intent.proposal).toBeNull();
    expect(intent.policyVerdict).toBeNull();
    expect(intent.durableLedgerEventId).toBeNull();
    expect(intent.createdAt).toEqual(now);
    expect(intent.updatedAt).toEqual(now);
  });

  it("rejects an empty id", () => {
    expect(() =>
      Intent.submit({ id: "", customerId: "cust_1", text: "pay" }),
    ).toThrow(InvalidIntentError);
  });

  it("rejects an empty text (after trim)", () => {
    expect(() =>
      Intent.submit({ id: "intent_1", customerId: "cust_1", text: "   " }),
    ).toThrow(InvalidIntentError);
  });

  it("rejects text over the max length", () => {
    expect(() =>
      Intent.submit({
        id: "intent_1",
        customerId: "cust_1",
        text: "x".repeat(MAX_INTENT_TEXT_LENGTH + 1),
      }),
    ).toThrow(InvalidIntentError);
  });

  it("rejects a malformed customerId", () => {
    expect(() =>
      Intent.submit({ id: "intent_1", customerId: "cust 1!", text: "pay" }),
    ).toThrow(InvalidIntentError);
  });
});

describe("Intent.fromState", () => {
  it("rehydrates without validation and does not alias the input props", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const props: IntentProps = {
      id: "intent_1",
      customerId: "cust_1",
      text: "pay",
      status: "received",
      proposal: null,
      policyVerdict: null,
      durableLedgerEventId: null,
      clarificationAnswer: null,
      createdAt: now,
      updatedAt: now,
    };
    const intent = Intent.fromState(props);
    intent.clarify(clarifyProposal("Which invoice?"));

    expect(props.status).toBe("received");
    expect(props.proposal).toBeNull();
    expect(intent.status).toBe("needs_clarification");
  });
});

describe("Intent legal transitions", () => {
  it("clarify: received → needs_clarification, stores the clarify proposal", () => {
    const intent = submit();
    const before = intent.updatedAt;
    const question = clarifyProposal("Which invoice?");
    intent.clarify(question, new Date(before.getTime() + 1000));
    expect(intent.status).toBe("needs_clarification");
    expect(intent.proposal).toEqual(question);
  });

  it("propose: received → proposed, stores the payment proposal", () => {
    const intent = submit();
    intent.propose(proposal);
    expect(intent.status).toBe("proposed");
    expect(intent.proposal).toEqual(proposal);
  });

  it("propose: needs_clarification → proposed", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    intent.propose(proposal);
    expect(intent.status).toBe("proposed");
    expect(intent.proposal).toEqual(proposal);
  });

  it("declineByAgent: received → rejected (spec extension — see class header)", () => {
    const intent = submit();
    const decline = declineProposal("Looks like prompt injection.");
    intent.declineByAgent(decline);
    expect(intent.status).toBe("rejected");
    expect(intent.proposal).toEqual(decline);
  });

  it("declineByAgent: needs_clarification → rejected", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    const decline = declineProposal("Answer looks like manipulation.");
    intent.declineByAgent(decline);
    expect(intent.status).toBe("rejected");
    expect(intent.proposal).toEqual(decline);
  });

  it("requireApproval: proposed → needs_approval, stores the verdict", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.requireApproval(needsApprovalVerdict);
    expect(intent.status).toBe("needs_approval");
    expect(intent.policyVerdict).toEqual(needsApprovalVerdict);
  });

  it("rejectByPolicy: proposed → rejected, stores the verdict", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.rejectByPolicy(rejectVerdict);
    expect(intent.status).toBe("rejected");
    expect(intent.policyVerdict).toEqual(rejectVerdict);
  });

  it("rejectByApprover: needs_approval → rejected", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.requireApproval(needsApprovalVerdict);
    intent.rejectByApprover();
    expect(intent.status).toBe("rejected");
  });

  it("autoApprove: proposed → executing, stores verdict and durableLedgerEventId", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.autoApprove({
      verdict: allowVerdict,
      durableLedgerEventId: "evt_1",
    });
    expect(intent.status).toBe("executing");
    expect(intent.policyVerdict).toEqual(allowVerdict);
    expect(intent.durableLedgerEventId).toBe("evt_1");
  });

  it("approve: needs_approval → executing, stores durableLedgerEventId", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.requireApproval(needsApprovalVerdict);
    intent.approve("evt_2");
    expect(intent.status).toBe("executing");
    expect(intent.durableLedgerEventId).toBe("evt_2");
  });

  it("complete: executing → completed", () => {
    const intent = intentAt("executing");
    intent.complete();
    expect(intent.status).toBe("completed");
  });

  it("fail: executing → failed", () => {
    const intent = intentAt("executing");
    intent.fail();
    expect(intent.status).toBe("failed");
  });

  it("flagForReview: executing → needs_review", () => {
    const intent = intentAt("executing");
    intent.flagForReview();
    expect(intent.status).toBe("needs_review");
  });
});

describe("Intent illegal transitions", () => {
  const methodCalls: Record<string, (intent: Intent) => void> = {
    clarify: (i) => i.clarify(clarifyProposal("q")),
    recordClarificationAnswer: (i) => i.recordClarificationAnswer("answer"),
    propose: (i) => i.propose(proposal),
    declineByAgent: (i) => i.declineByAgent(declineProposal("no")),
    requireApproval: (i) => i.requireApproval(needsApprovalVerdict),
    rejectByPolicy: (i) => i.rejectByPolicy(rejectVerdict),
    rejectByApprover: (i) => i.rejectByApprover(),
    autoApprove: (i) =>
      i.autoApprove({ verdict: allowVerdict, durableLedgerEventId: "evt_x" }),
    approve: (i) => i.approve("evt_x"),
    complete: (i) => i.complete(),
    fail: (i) => i.fail(),
    flagForReview: (i) => i.flagForReview(),
  };

  const allowedFrom: Record<string, readonly IntentStatus[]> = {
    clarify: ["received"],
    recordClarificationAnswer: ["needs_clarification"],
    propose: ["received", "needs_clarification"],
    declineByAgent: ["received", "needs_clarification"],
    requireApproval: ["proposed"],
    rejectByPolicy: ["proposed"],
    rejectByApprover: ["needs_approval"],
    autoApprove: ["proposed"],
    approve: ["needs_approval"],
    complete: ["executing"],
    fail: ["executing"],
    flagForReview: ["executing"],
  };

  for (const [method, call] of Object.entries(methodCalls)) {
    const allowed = allowedFrom[method] ?? [];
    for (const status of ALL_STATUSES) {
      if (allowed.includes(status)) continue;
      it(`${method} throws InvalidIntentStateError from "${status}"`, () => {
        const intent = intentAt(status);
        expect(() => call(intent)).toThrow(InvalidIntentStateError);
        try {
          call(intent);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidIntentStateError);
          const stateError = error as InvalidIntentStateError;
          expect(stateError.code).toBe("invalid_intent_state");
          expect(stateError.name).toBe("InvalidIntentStateError");
          expect(stateError.from).toBe(status);
          expect(stateError.attempted).toBe(method);
        }
      });
    }
  }

  it("forbids every transition from every terminal status", () => {
    for (const status of TERMINAL_INTENT_STATUSES) {
      const intent = intentAt(status);
      for (const call of Object.values(methodCalls)) {
        expect(() => call(intent)).toThrow(InvalidIntentStateError);
      }
    }
  });
});

describe("only one clarification round", () => {
  it("forbids clarify on an already needs_clarification intent", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    expect(() => intent.clarify(clarifyProposal("Which one again?"))).toThrow(
      InvalidIntentStateError,
    );
  });
});

describe("recordClarificationAnswer", () => {
  it("stores the answer verbatim from needs_clarification, status unchanged, updatedAt advances", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    const before = intent.updatedAt;
    const now = new Date(before.getTime() + 1000);
    intent.recordClarificationAnswer("Invoice #123, $50.00", now);

    expect(intent.status).toBe("needs_clarification");
    expect(intent.clarificationAnswer).toBe("Invoice #123, $50.00");
    expect(intent.updatedAt).toEqual(now);
  });

  it("throws InvalidIntentError on a second call, leaving the first answer unchanged", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    intent.recordClarificationAnswer("Invoice #123");

    expect(() => intent.recordClarificationAnswer("Invoice #456")).toThrow(
      InvalidIntentError,
    );
    expect(intent.clarificationAnswer).toBe("Invoice #123");
  });

  it("throws InvalidIntentError on a blank answer (after trim)", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    expect(() => intent.recordClarificationAnswer("   ")).toThrow(
      InvalidIntentError,
    );
    expect(intent.clarificationAnswer).toBeNull();
  });

  it("throws InvalidIntentError on an answer over the max length", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    expect(() =>
      intent.recordClarificationAnswer(
        "x".repeat(MAX_CLARIFICATION_ANSWER_LENGTH + 1),
      ),
    ).toThrow(InvalidIntentError);
    expect(intent.clarificationAnswer).toBeNull();
  });
});

describe("durableLedgerEventId exactly-once (spec §6)", () => {
  it("is fixed on the first transition into executing via autoApprove and a second autoApprove call throws without changing it", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.autoApprove({
      verdict: allowVerdict,
      durableLedgerEventId: "evt_1",
    });
    expect(intent.durableLedgerEventId).toBe("evt_1");

    expect(() =>
      intent.autoApprove({
        verdict: allowVerdict,
        durableLedgerEventId: "evt_2",
      }),
    ).toThrow(InvalidIntentStateError);
    expect(intent.durableLedgerEventId).toBe("evt_1");
  });

  it("is fixed on the first transition into executing via approve and a second approve call throws without changing it", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.requireApproval(needsApprovalVerdict);
    intent.approve("evt_1");
    expect(intent.durableLedgerEventId).toBe("evt_1");

    expect(() => intent.approve("evt_2")).toThrow(InvalidIntentStateError);
    expect(intent.durableLedgerEventId).toBe("evt_1");
  });
});

describe("paymentProposal getter", () => {
  it("narrows to the PaymentProposal when the stored proposal is propose_payment", () => {
    const intent = submit();
    intent.propose(proposal);
    expect(intent.paymentProposal).toEqual(proposal);
  });

  it("returns null when the stored proposal is clarify", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    expect(intent.paymentProposal).toBeNull();
  });

  it("returns null when the stored proposal is decline", () => {
    const intent = submit();
    intent.declineByAgent(declineProposal("no"));
    expect(intent.paymentProposal).toBeNull();
  });

  it("returns null when there is no proposal at all", () => {
    const intent = submit();
    expect(intent.paymentProposal).toBeNull();
  });
});

describe("toState", () => {
  it("returns an independent copy", () => {
    const intent = submit();
    const state = intent.toState();
    intent.clarify(clarifyProposal("Which invoice?"));
    expect(state.status).toBe("received");
    expect(intent.status).toBe("needs_clarification");
  });

  it("carries clarificationAnswer through a toState()/fromState() round-trip", () => {
    const intent = submit();
    intent.clarify(clarifyProposal("Which invoice?"));
    intent.recordClarificationAnswer("Invoice #123, $50.00");

    const rehydrated = Intent.fromState(intent.toState());
    expect(rehydrated.clarificationAnswer).toBe("Invoice #123, $50.00");
    expect(rehydrated.status).toBe("needs_clarification");
  });
});

describe("updatedAt / createdAt", () => {
  it("advances updatedAt on every transition while createdAt never changes", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const intent = submit(t0);
    expect(intent.createdAt).toEqual(t0);
    expect(intent.updatedAt).toEqual(t0);

    const t1 = new Date("2026-01-01T00:01:00Z");
    intent.propose(proposal, t1);
    expect(intent.updatedAt).toEqual(t1);
    expect(intent.createdAt).toEqual(t0);

    const t2 = new Date("2026-01-01T00:02:00Z");
    intent.autoApprove(
      { verdict: allowVerdict, durableLedgerEventId: "evt_1" },
      t2,
    );
    expect(intent.updatedAt).toEqual(t2);
    expect(intent.createdAt).toEqual(t0);

    const t3 = new Date("2026-01-01T00:03:00Z");
    intent.complete(t3);
    expect(intent.updatedAt).toEqual(t3);
    expect(intent.createdAt).toEqual(t0);
  });
});

describe("isTerminal", () => {
  const expected: Record<IntentStatus, boolean> = {
    received: false,
    needs_clarification: false,
    proposed: false,
    needs_approval: false,
    rejected: true,
    executing: false,
    completed: true,
    failed: true,
    needs_review: true,
  };

  for (const status of ALL_STATUSES) {
    it(`isTerminal is ${String(expected[status])} for "${status}"`, () => {
      expect(intentAt(status).isTerminal).toBe(expected[status]);
    });
  }
});

describe("three-way-derivable rejection cause", () => {
  it("case 1: the agent declined — proposal.kind === 'decline', policyVerdict is null", () => {
    const intent = submit();
    intent.declineByAgent(declineProposal("Suspected prompt injection."));
    expect(intent.status).toBe("rejected");
    expect(intent.proposal?.kind).toBe("decline");
    expect(intent.policyVerdict).toBeNull();
  });

  it("case 2: policy rejected — policyVerdict.decision === 'reject', proposal is not a decline", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.rejectByPolicy(rejectVerdict);
    expect(intent.status).toBe("rejected");
    expect(intent.policyVerdict?.decision).toBe("reject");
    expect(intent.proposal?.kind).not.toBe("decline");
  });

  it("case 3: a human rejected it — neither a decline proposal nor a reject verdict", () => {
    const intent = submit();
    intent.propose(proposal);
    intent.requireApproval(needsApprovalVerdict);
    intent.rejectByApprover();
    expect(intent.status).toBe("rejected");
    expect(intent.proposal?.kind).not.toBe("decline");
    expect(intent.policyVerdict?.decision).not.toBe("reject");
  });
});
