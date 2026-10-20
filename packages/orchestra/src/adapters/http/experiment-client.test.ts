import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

// Dynamic URL imports the shipped browser module in Node without requiring DOM.
const client = (await import(
  new URL("../../../public/experiment-client.js", import.meta.url).href
)) as {
  needsAutomaticRead(intent: unknown, evidence: unknown): boolean;
  sourceInvoice(
    intent: unknown,
    challenge: string | null,
  ): { label: string; amount: number | null };
  duplicateBaseline(
    intent: unknown,
    evidence: unknown,
  ): { intentId: string; capturedAmount: number; entryIds: string[] } | null;
  recoveredOperations(attempts: unknown[]): string[];
  sourceDisplayText(
    source: string,
    challenge: string | null,
    mode: string,
  ): string;
  testAssessment(
    challenge: string,
    intent: unknown,
    evidence: unknown,
  ): { label: string; detail: string; tone: string };
  casePlanPresentation(
    challenge: unknown,
    intent: unknown,
    evidence: unknown,
    batch: unknown,
  ): { title: string; expected: string; observed: string; provenance: string };
  operationPresentation(attempt: unknown): {
    title: string;
    purpose: string;
    transport: string;
    outcome: string;
    duration: string;
    phase: string;
    caveat: string;
  };
  currentOperationContext(
    attempt: unknown,
    evidence: unknown,
  ): { snapshot: unknown; entryIds: string[] };
  receiptPresentation(
    receipt: unknown,
    evidence?: unknown,
  ): {
    label: string;
    tone: string;
    detail: string;
    reason: string | null;
  };
  requestJson(
    url: string,
    options: Record<string, unknown>,
    fetchImpl: typeof fetch,
  ): Promise<unknown>;
  policyPresentation(
    intent: {
      status: string;
      durableLedgerEventId: string | null;
      policyVerdict: { decision: string; reason: string };
    },
    preset?: boolean,
  ): { label: string; explanation: string };
  paymentPresentation(
    intent: unknown,
    evidence: unknown,
    batch: unknown,
    challenge: unknown,
    baseline?: unknown,
  ): {
    paid: string;
    state: string;
    verdict: string;
    detail: string;
    tone: string;
  };
  summarizeLedger(
    entries: readonly {
      direction: string;
      amount: { amount: number; currency: string };
    }[],
  ): { balanced: boolean; label: string };
};
describe("same-page experiment client", () => {
  it("surfaces backend action errors and never treats unreadable HTML as success", async () => {
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Payment requires review" } }),
          { status: 409 },
        ),
      );
    await expect(
      client.requestJson("/api/intents/i/resend", { method: "POST" }, denied),
    ).rejects.toThrow("Payment requires review");
    expect(denied).toHaveBeenCalledWith(
      "/api/intents/i/resend",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }),
    );
    await expect(
      client.requestJson(
        "/ui/intents",
        {},
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("<html>error</html>")),
      ),
    ).rejects.toThrow("unreadable response");
  });
  it("computes balanced evidence from actual same-currency entries", () => {
    const entries = [
      { direction: "debit", amount: { amount: 120000, currency: "USD" } },
      { direction: "credit", amount: { amount: 120000, currency: "USD" } },
    ];
    expect(client.summarizeLedger(entries)).toMatchObject({ balanced: true });
    expect(client.summarizeLedger(entries).label).toContain("net 0.00 USD");
    expect(
      client.summarizeLedger([
        ...entries.slice(0, 1),
        { direction: "credit", amount: { amount: 500, currency: "USD" } },
      ]).balanced,
    ).toBe(false);
    expect(
      client.summarizeLedger([
        ...entries.slice(0, 1),
        { direction: "credit", amount: { amount: 120000, currency: "EUR" } },
      ]).balanced,
    ).toBe(false);
  });
  it("shows accepted approval and reviewer rejection from actual backend fields", () => {
    const view = {
      status: "needs_approval",
      durableLedgerEventId: null,
      policyVerdict: {
        decision: "needs_approval",
        reason: "above_auto_approve_threshold",
      },
    };
    expect(client.policyPresentation(view).label).toBe("Approval required");
    expect(
      client.policyPresentation({
        ...view,
        status: "completed",
        durableLedgerEventId: "event",
      }).label,
    ).toBe("Approval received");
    expect(
      client.policyPresentation({ ...view, status: "rejected" }).label,
    ).toBe("Reviewer stopped payment");
    expect(
      client.policyPresentation({
        ...view,
        status: "rejected",
        policyVerdict: { decision: "reject", reason: "amount_not_grounded" },
      }).label,
    ).toBe("Blocked");
  });
  it("keeps captured money unknown without a snapshot and requires ten real receipts for duplicate proof", () => {
    const completed = {
      status: "completed",
      policyVerdict: { decision: "allow" },
    };
    expect(
      client.paymentPresentation(
        completed,
        { ledger: { entries: [] } },
        null,
        "duplicates",
      ).paid,
    ).toBe("Unknown");
    expect(
      client.paymentPresentation(
        completed,
        { ledger: { entries: [] } },
        null,
        "duplicates",
      ).tone,
    ).toBe("warn");
    const payment = {
      payment: {
        availability: "known",
        snapshot: {
          id: "p",
          status: "failed",
          currency: "USD",
          capturedAmount: 0,
        },
      },
    };
    const declined = client.paymentPresentation(
      { status: "failed" },
      payment,
      null,
      "permanent_decline",
    );
    expect(declined.paid).toBe("0.00 USD");
    expect(declined.state).toBe("Payment refused · $0 captured");
    const unknown = client.paymentPresentation(
      { status: "failed" },
      { journal: { attempts: [] } },
      null,
      "permanent_decline",
    );
    expect(unknown.paid).toBe("Unknown");
    expect(unknown.tone).not.toBe("good");
  });
  it("only verifies the duplicate result with ten matching receipts and authoritative money/ledger proof", () => {
    const intent = { id: "original", status: "completed" };
    const baseline = {
      intentId: "original",
      paymentId: "p",
      capturedAmount: 50000,
      currency: "USD",
      entryIds: ["credit", "debit"],
    };
    const current = {
      payment: {
        availability: "known",
        snapshot: {
          id: "p",
          status: "captured",
          currency: "USD",
          capturedAmount: 50000,
        },
      },
      ledger: {
        proof: { paymentId: "p", currency: "USD", capturedAmount: 50000 },
        entries: [{ id: "debit" }, { id: "credit" }],
      },
    };
    const receipt = {
      status: "fulfilled",
      result: {
        capture: { id: "p" },
        unchangedEntries: true,
        ledgerOutcome: "already_posted",
        entryCountBefore: 2,
        entryCountAfter: 2,
        originalEntryIds: ["debit", "credit"],
        returnedEntryIds: ["credit", "debit"],
      },
    };
    const batch = {
      invariantVerified: true,
      receipts: Array.from({ length: 10 }, () => receipt),
    };
    expect(
      client.paymentPresentation(intent, current, batch, "duplicates", baseline)
        .tone,
    ).toBe("good");
    expect(
      client.paymentPresentation(
        intent,
        current,
        { ...batch, receipts: batch.receipts.slice(1) },
        "duplicates",
      ).tone,
    ).toBe("warn");
    expect(
      client.paymentPresentation(
        intent,
        current,
        {
          ...batch,
          receipts: [
            ...batch.receipts.slice(1),
            { ...receipt, status: "unknown" },
          ],
        },
        "duplicates",
      ).tone,
    ).toBe("warn");
    expect(
      client.paymentPresentation(
        intent,
        { ...current, payment: { availability: "unknown", snapshot: null } },
        batch,
        "duplicates",
      ).tone,
    ).toBe("warn");
  });
  it("ships partial polling and safe DOM rendering without page navigation", async () => {
    const source = await readFile(
      new URL("../../../public/experiment-client.js", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /innerHTML|location\.(?:href|reload|assign)|document\.write/,
    );
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain("polls >= 60");
    expect(source).toContain("stopPolling()");
    expect(source).toContain("textContent");
  });
  it("distinguishes an actual policy stop before dispatch from unknown payment evidence", () => {
    const rejected = {
      status: "rejected",
      durableLedgerEventId: null,
      policyVerdict: { decision: "reject" },
      proposal: { amount: 500000, currency: "USD" },
    };
    expect(
      client.paymentPresentation(rejected, null, null, "inflated_amount"),
    ).toMatchObject({
      paid: "Not sent",
      state: "Policy stopped this before payment",
      tone: "bad",
    });
    expect(
      client.paymentPresentation(
        { ...rejected, durableLedgerEventId: "existing-event" },
        null,
        null,
        null,
      ).paid,
    ).toBe("Unknown");
  });
  it("explains expected counts separately from incomplete observed journal and delivery counts", () => {
    const attempts = Array.from({ length: 22 }, () => ({
      outcome: "succeeded",
    }));
    const model = client.casePlanPresentation(
      "duplicates",
      { durableLedgerEventId: "event" },
      { journal: { available: true, attempts } },
      {
        receipts: [
          { status: "fulfilled" },
          { status: "unknown" },
          { status: "not_attempted" },
        ],
      },
    );
    expect(model.expected).toContain("23 operations");
    expect(model.observed).toContain("22 recorded operations");
    expect(model.observed).toContain(
      "2 attempted, 1 fulfilled, 0 failed, 1 unknown, 1 not attempted",
    );
    expect(model.provenance).toContain("not mapped to journal rows");
    expect(
      client.casePlanPresentation("temporary_failure", null, null, null)
        .provenance,
    ).not.toContain("ten repeat deliveries");
    expect(
      client.casePlanPresentation(null, null, null, { unknown: true })
        .provenance,
    ).toContain("ten repeat deliveries");
    expect(
      client.casePlanPresentation(
        "duplicates",
        { durableLedgerEventId: "e" },
        { journal: { available: false, attempts: [] } },
        { unknown: true },
      ).observed,
    ).toContain("history is unavailable");
    expect(
      client.casePlanPresentation(
        "duplicates",
        { durableLedgerEventId: "e" },
        null,
        null,
      ).observed,
    ).toContain("not available yet");
  });
  it("gives each challenge and manual requests a truthful planned path before execution", () => {
    expect(
      client.casePlanPresentation("temporary_failure", null, null, null)
        .expected,
    ).toContain("5 operations");
    expect(
      client.casePlanPresentation("inflated_amount", null, null, null).expected,
    ).toContain("no payment operations expected");
    expect(
      client.casePlanPresentation("permanent_decline", null, null, null)
        .expected,
    ).toContain("failed payment record");

    expect(
      client.casePlanPresentation("duplicates", null, null, null).observed,
    ).toBe("No saved result yet.");
  });
  it("uses the actual policy reason when an expected duplicate test hits the daily limit", () => {
    const intent = {
      status: "rejected",
      durableLedgerEventId: null,
      policyVerdict: {
        decision: "reject",
        reason: "daily_rate_limit_exceeded",
      },
    };
    const result = client.paymentPresentation(intent, null, null, "duplicates");
    expect(result.verdict).toContain("daily request limit");
    expect(result.detail).not.toContain("unsupported amount");
    expect(result.tone).toBe("bad");
    expect(
      client.casePlanPresentation("duplicates", intent, null, null).observed,
    ).toContain("No workflow was started");
    expect(
      client.casePlanPresentation("duplicates", intent, null, null).observed,
    ).toContain("daily request limit");
  });
  it("distinguishes local recording, returned calls, and current related evidence", () => {
    const attempt = {
      step: "post-ledger",
      outcome: "succeeded",
      phase: "resend",
      startedAt: "2026-10-16T00:00:00.000Z",
      endedAt: "2026-10-16T00:00:00.023Z",
      paymentId: "one",
      operationId: "op",
    };
    const model = client.operationPresentation(attempt);
    expect(model.transport).toContain("not an HTTP call");
    expect(model.duration).toBe("23 ms");
    expect(model.phase).toContain("no delivery number");
    expect(model.caveat).toContain("does not by itself prove");
    expect(
      client.operationPresentation({ ...attempt, outcome: "failed" }).caveat,
    ).toContain("recorded an error");
    expect(
      client.operationPresentation({ ...attempt, outcome: "failed" }).caveat,
    ).not.toContain("Returned means");
    expect(
      client.operationPresentation({
        ...attempt,
        outcome: "started",
        endedAt: null,
      }).caveat,
    ).toBe("No final outcome recorded yet.");
    expect(
      client.operationPresentation({
        ...attempt,
        endedAt: null,
        outcome: "started",
      }).duration,
    ).toBe("Duration unknown");
    const evidence = {
      payment: { availability: "known", snapshot: { id: "other" } },
      ledger: {
        entries: [
          { id: "wrong", paymentId: "other", operationId: "op" },
          { id: "right", paymentId: "one", operationId: "op" },
        ],
      },
    };
    expect(client.currentOperationContext(attempt, evidence)).toEqual({
      snapshot: null,
      entryIds: ["right"],
    });
    expect(
      client.currentOperationContext(attempt, {
        ...evidence,
        payment: {
          availability: "known",
          snapshot: { id: "one", status: "captured" },
        },
      }).snapshot,
    ).toEqual({ id: "one", status: "captured" });
  });
  it("explains every partial delivery status and only highlights actual matching receipt identities", () => {
    const result = {
      capture: {
        id: "p",
        status: "captured",
        capturedAmount: 50000,
        currency: "USD",
      },
      ledgerOutcome: "already_posted",
      unchangedEntries: true,
      originalEntryIds: ["a", "b"],
      returnedEntryIds: ["b", "a"],
      entryCountBefore: 2,
      entryCountAfter: 2,
    };
    const reference = {
      ledger: {
        proof: { paymentId: "p", capturedAmount: 50000, currency: "USD" },
        entries: [{ id: "a" }, { id: "b" }],
      },
    };
    expect(
      client.receiptPresentation({ status: "fulfilled", result }, reference),
    ).toMatchObject({ tone: "verified" });
    expect(
      client.receiptPresentation({ status: "fulfilled", result }).tone,
    ).toBe("returned");
    expect(
      client.receiptPresentation(
        {
          status: "fulfilled",
          result: {
            ...result,
            capture: { ...result.capture, id: "unrelated" },
          },
        },
        reference,
      ).tone,
    ).not.toBe("verified");
    expect(
      client.receiptPresentation({
        status: "fulfilled",
        result: { ...result, returnedEntryIds: ["x", "y"] },
      }).tone,
    ).toBe("uncertain");
    expect(
      client.receiptPresentation({ status: "fulfilled", result: null }).tone,
    ).toBe("uncertain");
    expect(
      client.receiptPresentation({ status: "unknown", result: null }).label,
    ).toBe("Outcome unknown");
    expect(
      client.receiptPresentation({ status: "not_attempted", result: null })
        .detail,
    ).toContain("before sending");
    expect(
      client.receiptPresentation({
        status: "failed",
        result: null,
        reason: "delivery_rejected",
      }).reason,
    ).toBe("delivery_rejected");
  });
  it("assesses actual guard and refusal evidence rather than the selected test label", () => {
    const guarded = {
      status: "rejected",
      durableLedgerEventId: null,
      policyVerdict: { decision: "reject", reason: "amount_not_grounded" },
    };
    expect(client.testAssessment("inflated_amount", guarded, null).tone).toBe(
      "good",
    );
    expect(
      client.testAssessment(
        "inflated_amount",
        {
          ...guarded,
          policyVerdict: {
            decision: "reject",
            reason: "daily_rate_limit_exceeded",
          },
        },
        null,
      ).tone,
    ).not.toBe("good");
    const failed = { status: "failed" },
      evidence = {
        payment: {
          availability: "known",
          snapshot: { status: "failed", capturedAmount: 0 },
        },
        ledger: { proof: null, entries: [] },
      };
    expect(
      client.testAssessment("permanent_decline", failed, evidence).tone,
    ).toBe("good");
    expect(
      client.testAssessment("permanent_decline", failed, {
        ...evidence,
        ledger: { proof: { paymentId: "contradiction" }, entries: [] },
      }).tone,
    ).not.toBe("good");
    expect(
      client.testAssessment("permanent_decline", failed, null).tone,
    ).not.toBe("good");
  });
  it("requires real matching retry observations and consistent payment proof for recovery", () => {
    const attempts = ["authorize", "capture"].flatMap((step) => [
      {
        step,
        runId: "run",
        idempotencyKey: step,
        phase: "workflow",
        outcome: "failed",
        startedAt: "2026-10-16T00:00:00.000Z",
      },
      {
        step,
        runId: "run",
        idempotencyKey: step,
        phase: "workflow",
        outcome: "succeeded",
        startedAt: "2026-10-16T00:00:01.000Z",
      },
    ]);
    const evidence = {
      resendAvailable: false,
      payment: {
        availability: "known",
        snapshot: {
          id: "p",
          status: "captured",
          capturedAmount: 50000,
          currency: "USD",
        },
      },
      ledger: {
        proof: { paymentId: "p", capturedAmount: 50000, currency: "USD" },
        entries: ["debit", "credit"].map((direction, index) => ({
          id: String(index),
          direction,
          paymentId: "p",
          amount: { amount: 50000, currency: "USD" },
        })),
      },
      journal: { available: true, attempts },
    };
    expect(
      client.testAssessment(
        "temporary_failure",
        { status: "completed" },
        evidence,
      ).tone,
    ).toBe("good");
    for (const proof of [
      { paymentId: "p", capturedAmount: 50001, currency: "USD" },
      { paymentId: "p", capturedAmount: 50000, currency: "EUR" },
    ])
      expect(
        client.testAssessment(
          "temporary_failure",
          { status: "completed" },
          { ...evidence, ledger: { ...evidence.ledger, proof } },
        ).tone,
      ).not.toBe("good");
    expect(
      client.recoveredOperations(
        attempts.map((a) =>
          a.outcome === "succeeded"
            ? { ...a, idempotencyKey: "other", runId: "other" }
            : a,
        ),
      ),
    ).toEqual([]);
    expect(
      client.testAssessment(
        "temporary_failure",
        { status: "completed" },
        { ...evidence, journal: { available: false, attempts: [] } },
      ).tone,
    ).not.toBe("good");
    expect(
      client.duplicateBaseline({ id: "i", status: "completed" }, evidence),
    ).toBeNull();
    expect(
      client.duplicateBaseline(
        { id: "i", status: "completed" },
        { ...evidence, resendAvailable: true },
      ),
    ).toMatchObject({
      intentId: "i",
      capturedAmount: 50000,
      entryIds: ["0", "1"],
    });
  });
  it("hides a mock directive only for the exact known preset source", () => {
    const raw = "Pay the vendor $500.00 for the invoice. sim.amount.inflated";
    expect(client.sourceDisplayText(raw, "inflated_amount", "mock")).toBe(
      "Pay the vendor $500.00 for the invoice.",
    );
    expect(client.sourceDisplayText(raw, null, "mock")).toBe(raw);
    expect(
      client.sourceDisplayText(
        raw + " arbitrary manual text",
        "inflated_amount",
        "mock",
      ),
    ).toBe(raw + " arbitrary manual text");
    expect(client.sourceDisplayText(raw, "inflated_amount", "live")).toBe(raw);
  });
  it("explains human decisions without inventing a zero captured snapshot", () => {
    const waiting = client.paymentPresentation(
      {
        status: "needs_clarification",
        durableLedgerEventId: null,
        proposal: { question: "Which amount?" },
      },
      null,
      null,
      null,
    );
    expect(waiting.verdict).toContain("clarify");
    expect(waiting.detail).toBe("Which amount?");
    const stopped = client.paymentPresentation(
      {
        status: "rejected",
        durableLedgerEventId: null,
        policyVerdict: { decision: "needs_approval" },
      },
      null,
      null,
      null,
    );
    expect(stopped.verdict).toBe("You stopped this payment.");
    expect(stopped.paid).toBe("Not started");
    expect(
      client.paymentPresentation(
        {
          status: "rejected",
          durableLedgerEventId: null,
          proposal: { kind: "decline", reason: "No grounded amount" },
        },
        null,
        null,
        null,
      ).detail,
    ).toBe("No grounded amount");
  });
  it("reads essential terminal proof but never waits for best-effort journal records", () => {
    const intent = { status: "completed", durableLedgerEventId: "event" };
    expect(client.needsAutomaticRead(intent, null)).toBe(true);
    expect(
      client.needsAutomaticRead(
        { status: "rejected", durableLedgerEventId: null },
        null,
      ),
    ).toBe(false);
    expect(
      client.needsAutomaticRead(
        { status: "failed", durableLedgerEventId: "event" },
        null,
      ),
    ).toBe(true);
    expect(
      client.needsAutomaticRead(
        { status: "failed", durableLedgerEventId: "event" },
        {
          payment: {
            availability: "known",
            snapshot: { status: "failed", capturedAmount: 0 },
          },
        },
      ),
    ).toBe(false);
    const evidence = {
      journal: { available: false, attempts: [] },
      payment: {
        availability: "known",
        snapshot: {
          id: "p",
          status: "captured",
          capturedAmount: 50000,
          currency: "USD",
        },
      },
      ledger: {
        proof: { paymentId: "p", capturedAmount: 50000, currency: "USD" },
        entries: ["debit", "credit"].map((direction, index) => ({
          id: String(index),
          paymentId: "p",
          direction,
          amount: { amount: 50000, currency: "USD" },
        })),
      },
    };
    expect(client.needsAutomaticRead(intent, evidence)).toBe(false);
  });
  it("labels the actual preset approval actor and keeps planned amounts separate from recorded sources", () => {
    const verdict = client.policyPresentation(
      {
        status: "executing",
        durableLedgerEventId: "event",
        policyVerdict: {
          decision: "needs_approval",
          reason: "above_auto_approve_threshold",
        },
      },
      true,
    );
    expect(verdict.label).toBe("Simulation authorized");
    expect(verdict.explanation).not.toContain("human");
    expect(verdict.explanation).toContain("Starting this preset authorized");
    expect(client.sourceInvoice(null, "permanent_decline").amount).toBe(60000);
    expect(
      client.sourceInvoice(
        { text: "Pay the vendor $500.00 for the invoice." },
        "permanent_decline",
      ).amount,
    ).toBe(50000);
    expect(
      client.sourceInvoice(
        { text: "Pay the vendor $600.00 for the invoice." },
        "permanent_decline",
      ).amount,
    ).toBe(60000);
    expect(
      client.sourceInvoice(
        { text: "Unrecognized stored source" },
        "permanent_decline",
      ).amount,
    ).toBeNull();
    expect(
      client.sourceInvoice(
        { text: "Pay the vendor $500.00 for the invoice. sim.amount.inflated" },
        "inflated_amount",
      ).amount,
    ).toBe(50000);
  });
});
