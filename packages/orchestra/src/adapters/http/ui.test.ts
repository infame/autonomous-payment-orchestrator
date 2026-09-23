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
    expect(out).toContain('action="/ui/intents"');
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
