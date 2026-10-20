import { describe, expect, it } from "vitest";
import { renderIntentDetail, renderHome, renderErrorPage } from "./ui.js";

/**
 * Every field interpolated in `ui.ts` is ultimately model- or
 * customer-controlled (`reasoning`/`merchantId`/`text`/`question`/`reason`
 * all come from `intentText`, a clarification answer, or an `AgentProposal`
 * — see that file's own header). These pins prove `hono/html`'s
 * auto-escaping is actually in effect for every one of them, not just
 * asserted in a comment.
 */
describe("ui rendering — HTML escaping", () => {
  it("escapes a <script> tag in proposal.reasoning", async () => {
    const rendered = await renderIntentDetail(
      {
        id: "intent-1",
        status: "needs_approval",
        text: "Pay the vendor.",
        proposal: {
          kind: "propose_payment",
          amount: 12_000,
          currency: "USD",
          merchantId: "vendor",
          reasoning: '<script>alert("xss")</script>',
        },
        durableLedgerEventId: null,
      },
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes quotes and angle brackets in merchantId", async () => {
    const rendered = await renderIntentDetail(
      {
        id: "intent-2",
        status: "needs_approval",
        text: "Pay the vendor.",
        proposal: {
          kind: "propose_payment",
          amount: 12_000,
          currency: "USD",
          merchantId: `"><img src=x onerror=alert(1)>`,
          reasoning: "ordinary reasoning",
        },
        durableLedgerEventId: null,
      },
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).not.toContain('"><img src=x onerror=alert(1)>');
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img");
  });

  it("escapes a clarify question", async () => {
    const rendered = await renderIntentDetail(
      {
        id: "intent-3",
        status: "needs_clarification",
        text: "Pay the vendor.",
        proposal: {
          kind: "clarify",
          question: "<img src=x onerror=alert(1)>",
        },
        durableLedgerEventId: null,
      },
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).not.toContain("<img src=x onerror");
  });

  it("escapes intent text itself", async () => {
    const rendered = await renderIntentDetail(
      {
        id: "intent-4",
        status: "needs_clarification",
        text: "<script>document.cookie</script>",
        proposal: null,
        durableLedgerEventId: null,
      },
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).not.toContain("<script>document.cookie");
  });

  it("renders the home page without throwing and includes the mode banner", async () => {
    const rendered = await renderHome("live", 7);
    const out = rendered.toString();
    expect(out).toContain("Live mode");
    expect(out).toContain("7 calls left");
  });

  it("escapes an upstream error message on the error page", async () => {
    const rendered = await renderErrorPage(
      '<script>alert("upstream")</script>',
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("&lt;script&gt;");
  });

  it("home page forms post to /ui/*, never directly to /api/* (which returns raw JSON, not HTML)", async () => {
    const rendered = await renderHome("mock", null);
    const out = rendered.toString();
    expect(out).toContain('action="/ui/challenges"');
    expect(out).not.toContain("hx-post");
  });

  it("intent detail's clarify form uses the real wire field name 'answer', not 'clarificationAnswer'", async () => {
    const rendered = await renderIntentDetail(
      {
        id: "intent-5",
        status: "needs_clarification",
        text: "Pay the vendor.",
        proposal: null,
        durableLedgerEventId: null,
      },
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).toContain('name="answer"');
    expect(out).not.toContain("clarificationAnswer");
    expect(out).toContain(`action="/ui/intents/intent-5/clarify"`);
  });

  it("intent detail's approve/reject forms post to /ui/*", async () => {
    const rendered = await renderIntentDetail(
      {
        id: "intent-6",
        status: "needs_approval",
        text: "Pay the vendor.",
        proposal: {
          kind: "propose_payment",
          amount: 1_000,
          currency: "USD",
          merchantId: "vendor",
          reasoning: "ok",
        },
        durableLedgerEventId: null,
      },
      "mock",
      null,
    );
    const out = rendered.toString();
    expect(out).toContain(`action="/ui/intents/intent-6/approve"`);
    expect(out).toContain(`action="/ui/intents/intent-6/reject"`);
  });
});

describe("guided payment review", () => {
  const view = {
    id: "review",
    status: "executing",
    text: "Pay vendor $500.00",
    proposal: null,
    durableLedgerEventId: "workflow",
  };

  it("shows only four mock challenges and a separate ordinary live request page", async () => {
    const mock = String(await renderHome("mock", null));
    expect(mock.match(/class="challenge-picker"/g)).toHaveLength(4);
    for (const removed of [
      "Manual tools",
      "Single exact resend",
      'id="request-form"',
      'id="review-controls"',
      'id="continue-action"',
      "Inspect the evidence",
    ])
      expect(mock).not.toContain(removed);
    expect(mock.indexOf("Recorded operations")).toBeLessThan(
      mock.indexOf("Before → after"),
    );
    expect(mock.indexOf("Recorded operations")).toBeLessThan(
      mock.indexOf("Simulated assistant proposal"),
    );
    const live = String(await renderHome("live", 2));
    expect(live).toContain('action="/ui/intents"');
    expect(live).not.toContain('id="experiment"');
    expect(live).not.toContain("experiment-client.js");
    expect(live).not.toContain('class="challenge-picker"');
  });

  it("escapes policy details, reason codes and clarification answers", async () => {
    const out = String(
      await renderIntentDetail(
        {
          ...view,
          clarificationAnswer: "<script>answer</script>",
          policyVerdict: {
            decision: "reject",
            reason: "<script>reason</script>",
            detail: "<img src=x onerror=alert(1)>",
          },
        },
        "mock",
        null,
      ),
    );
    expect(out).toContain("&lt;script&gt;answer");
    expect(out).toContain("&lt;script&gt;reason");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
  });

  it("refreshes only an executing backend and caps checks without claiming completion", async () => {
    const active = String(await renderIntentDetail(view, "mock", null, 29));
    expect(active).toContain('http-equiv="refresh"');
    expect(active).toContain("?poll=30");
    expect(active).toContain("Completion has not been confirmed");
    expect(active).toContain('class="loader"');
    expect(active).toContain('aria-current="step">Execution');
    expect(active).toContain("Waiting for backend confirmation");
    expect(active).not.toContain("Payment completed");
    const paused = String(await renderIntentDetail(view, "mock", null, 30));
    expect(paused).not.toContain('http-equiv="refresh"');
    expect(paused).toContain("Automatic checks paused");
  });

  it.each([
    "completed",
    "rejected",
    "failed",
    "needs_review",
    "proposed",
    "surprise",
  ])("stops auto refresh for %s", async (status) => {
    const out = String(
      await renderIntentDetail({ ...view, status }, "mock", null),
    );
    expect(out).not.toContain('http-equiv="refresh"');
    if (status !== "completed") expect(out).not.toContain("Payment completed");
    if (status === "needs_review")
      expect(out).toContain("Manual review is required");
    if (status === "failed") expect(out).toContain("Execution failed");
    if (status === "surprise") expect(out).toContain("unfamiliar status");
  });

  it("explains the actual policy reason before disclosing raw minor-unit limits", async () => {
    const approval = String(
      await renderIntentDetail(
        {
          ...view,
          status: "needs_approval",
          policyVerdict: {
            decision: "needs_approval",
            reason: "above_auto_approve_threshold",
            detail: "Amount is at or above the auto-approve threshold of 50000",
          },
        },
        "mock",
        null,
      ),
    ).replace(/\s+/g, " ");
    expect(approval).toContain(
      "This amount requires your approval before payment can start.",
    );
    const disclosure = approval.indexOf(
      "<summary>Technical policy details</summary>",
    );
    expect(disclosure).toBeGreaterThan(
      approval.indexOf("This amount requires your approval"),
    );
    expect(approval.indexOf("threshold of 50000")).toBeGreaterThan(disclosure);
    expect(approval).toContain("numeric amounts are in minor units");
    const blocked = String(
      await renderIntentDetail(
        {
          ...view,
          status: "rejected",
          policyVerdict: {
            decision: "reject",
            reason: "amount_not_grounded",
            detail: "Raw objection",
          },
        },
        "mock",
        null,
      ),
    ).replace(/\s+/g, " ");
    expect(blocked).toContain(
      "The proposed amount does not appear in the source request or accepted clarification.",
    );
    expect(blocked).not.toContain("This amount requires your approval");
  });

  it("distinguishes actual policy blocking from rejection at human review", async () => {
    const policy = String(
      await renderIntentDetail(
        {
          ...view,
          status: "rejected",
          policyVerdict: {
            decision: "reject",
            reason: "amount_not_grounded",
            detail: "Amount is unsupported",
          },
        },
        "mock",
        null,
      ),
    );
    expect(policy).toContain("Policy blocked the proposal");
    expect(policy).toContain("amount_not_grounded");
    expect(policy).toContain('aria-current="step">Policy');
    const human = String(
      await renderIntentDetail(
        {
          ...view,
          status: "rejected",
          durableLedgerEventId: null,
          policyVerdict: {
            decision: "needs_approval",
            reason: "above_auto_approve_threshold",
            detail: "Review needed",
          },
        },
        "mock",
        null,
      ),
    );
    expect(human).toContain("rejected before execution");
    expect(human).not.toContain("Policy blocked");
    expect(human).toContain('aria-current="step">Your review');
  });
});

describe("evidence explanations", () => {
  it("separates recorded operations, current related evidence, and actual delivery receipts", async () => {
    const page = String(await renderHome("mock", null)).replace(/\s+/g, " ");
    expect(page).toContain("Recorded operations");
    expect(page).toContain("Evidence color legend");
    expect(page).toContain("Green: verified identity match");
    expect(page).not.toContain("Recorded API calls");
    expect(page).toContain("Simulated assistant proposal");
    expect(page).toContain("not the historical response");
    expect(page).toContain("Net zero does not mean nothing was charged");
    expect(page).toContain('id="delivery-rows"');
    expect(page).toContain('id="operation-raw-disclosure"');
    expect(page).toContain('id="receipt-raw-disclosure"');
    expect(page).toContain('id="case-mechanics"');
    expect(page).toContain("Retry the same payment 10 times");
  });
  it("keeps short facts inline while retaining long raw payload disclosures", async () => {
    const page = String(await renderHome("mock", null)).replace(/\s+/g, " ");
    expect(page).toContain('id="read-status" role="status"');
    expect(page).not.toContain("Check payment result");
    expect(page).not.toContain('id="policy-raw"');
    expect(page).toContain('id="backend-state-raw"');
    expect(page).toContain("USD amounts are in cents: 50000 = $500.00");
    expect(page).toContain("<h4>Recorded source</h4>");
    expect(page).toContain("<h4>Entry identities</h4>");
    expect(page).toContain('id="operation-raw-disclosure"');
    expect(page).toContain('id="receipt-raw-disclosure"');
  });
});
