/**
 * Server-rendered HTMX views (`hono/html`). Every interpolated value below
 * goes through the `html` tagged template's own auto-escaping — NEVER
 * `raw()` on anything that originates from `intentText`, a clarification
 * answer, or an `AgentProposal` field (`reasoning`/`question`/`reason`/
 * `merchantId`), all of which are ultimately model- or customer-controlled
 * text that reaches this gateway over `/api/*`'s proxied responses. `raw()`
 * is reserved for this file's own static markup only. See `ui.test.ts`'s
 * escaping pins.
 *
 * Action forms (submit/approve/reject/clarify) POST to `/ui/*` routes
 * (`gateway-app.ts`), not directly to `/api/*`: `/api/*` is a raw JSON
 * proxy, and an `hx-post` swapping a JSON response body into a `<div>`
 * would just print `{"intent":{...}}` as literal text — not a rendered
 * page. `/ui/*` instead reuses `/api/*`'s own proxy logic internally
 * (budget check, origin check, timeout, header hygiene all included, not
 * re-implemented) and redirects to the resulting HTML view on success. The
 * `<body>` below is `hx-boost="true"`, so every same-origin link and plain
 * `<form>` on the page is progressively enhanced into an AJAX
 * navigation+swap by htmx where available, and degrades to an ordinary
 * full-page POST/redirect where it isn't (no JS, htmx failed to load) —
 * this file never hand-writes `hx-post`/`hx-target` itself.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type LlmMode = "mock" | "live";

export interface IntentProposalView {
  readonly kind: "propose_payment" | "clarify" | "decline";
  readonly reasoning?: string | undefined;
  readonly question?: string | undefined;
  readonly reason?: string | undefined;
  readonly amount?: number | undefined;
  readonly currency?: string | undefined;
  readonly merchantId?: string | undefined;
}

export interface IntentDetailView {
  readonly id: string;
  readonly status: string;
  readonly text: string;
  readonly proposal: IntentProposalView | null;
  readonly durableLedgerEventId: string | null;
}

function formatAmount(amount: number, currency: string): string {
  // Minor units -> major, 2-decimal display only — matches this whole
  // system's 2-decimal minor-unit assumption (policy/rules.ts's
  // ZERO_DECIMAL_CURRENCIES comment in @apo/agent-orchestrator). Purely
  // cosmetic; never used for a money decision.
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/** Static, non-interpolated CSS — enough to make the demo legible, nothing more. `raw()` is safe here because the string is a fixed literal, never touched by any caller-supplied value. */
const STYLE = raw(`<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  .banner { padding: 0.5rem 1rem; border-radius: 0.375rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
  .banner-mock { background: #eef2ff; }
  .banner-live { background: #fef3c7; }
  .banner form { display: inline; margin-left: 0.5rem; }
  .proposal { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.375rem; padding: 0.75rem 1rem; margin: 1rem 0; }
  .error { background: #fee2e2; border: 1px solid #fecaca; border-radius: 0.375rem; padding: 0.75rem 1rem; margin: 1rem 0; }
  textarea { width: 100%; min-height: 5rem; font-family: inherit; }
  form { margin: 0.75rem 0; }
  button { cursor: pointer; }
</style>`);

function modeBanner(
  mode: LlmMode,
  remainingCalls: number | null,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (mode === "mock") {
    return html`<div class="banner banner-mock">
      Mock mode — deterministic, free, no API key spent. A live-mode link is
      issued out of band by the operator (<code>POST /internal/grant</code>,
      admin-secret gated) — there is no self-service signup here by design (see
      <code>docs/adr/0020</code>).
    </div>`;
  }
  const remainingText =
    remainingCalls === null ? "" : ` (${String(remainingCalls)} calls left)`;
  return html`<div class="banner banner-live">
    Live mode${raw(remainingText)} — talking to a real model.
    <form method="post" action="/session/mock">
      <button type="submit">Back to mock</button>
    </form>
  </div>`;
}

async function layout(
  title: string,
  mode: LlmMode,
  remainingCalls: number | null,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
): Promise<HtmlEscapedString> {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} — orchestra</title>
        <script src="/public/htmx.min.js"></script>
        ${STYLE}
      </head>
      <body hx-boost="true">
        ${modeBanner(mode, remainingCalls)}
        <main>${body}</main>
      </body>
    </html>`;
}

export function renderHome(
  mode: LlmMode,
  remainingCalls: number | null,
): Promise<HtmlEscapedString> {
  const body = html`<h1>APO — Autonomous Payment Orchestrator</h1>
    <p>
      Submit an intent to see the agent reason, gate through policy, and (in
      mock mode) execute against the demo stack.
    </p>
    <form method="post" action="/ui/intents">
      <label
        >X-Customer-Id is set for you by this gateway's own session
        cookie.</label
      >
      <textarea
        name="text"
        required
        placeholder="Pay the vendor for the invoice..."
      ></textarea>
      <button type="submit">Submit intent</button>
    </form>`;
  return layout("Home", mode, remainingCalls, body);
}

export function renderIntentDetail(
  view: IntentDetailView,
  mode: LlmMode,
  remainingCalls: number | null,
): Promise<HtmlEscapedString> {
  const proposalBlock = renderProposal(view.proposal);
  const body = html`<p><a href="/">&larr; new intent</a></p>
    <h1>Intent ${view.id}</h1>
    <p>Status: <strong>${view.status}</strong></p>
    <p>Text: ${view.text}</p>
    ${proposalBlock}
    ${
      view.status === "needs_approval"
        ? html`<form method="post" action="/ui/intents/${view.id}/approve">
              <button type="submit">Approve</button>
            </form>
            <form method="post" action="/ui/intents/${view.id}/reject">
              <button type="submit">Reject</button>
            </form>`
        : ""
    }
    ${
      view.status === "needs_clarification"
        ? html`<form method="post" action="/ui/intents/${view.id}/clarify">
            <textarea name="answer" required></textarea>
            <button type="submit">Answer</button>
          </form>`
        : ""
    }`;
  return layout(`Intent ${view.id}`, mode, remainingCalls, body);
}

/** Rendered by `/ui/*` action routes when the internal proxied call fails (validation error, policy rejection, upstream error, budget exhaustion, …) — `message` is the upstream's own error message, which may echo back model- or customer-controlled text (e.g. a `validation_failed` detail), so it goes through the same auto-escaping as everything else in this file. */
export function renderErrorPage(
  message: string,
  mode: LlmMode,
  remainingCalls: number | null,
): Promise<HtmlEscapedString> {
  const body = html`<p><a href="/">&larr; back</a></p>
    <div class="error">
      <strong>Could not complete that action.</strong> ${message}
    </div>`;
  return layout("Error", mode, remainingCalls, body);
}

function renderProposal(
  proposal: IntentProposalView | null,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (proposal === null) {
    return html`<p><em>No proposal yet.</em></p>`;
  }
  if (proposal.kind === "propose_payment") {
    return html`<div class="proposal">
      <p>
        Proposed: ${formatAmount(proposal.amount ?? 0, proposal.currency ?? "")}
        to ${proposal.merchantId ?? ""}
      </p>
      <p>Reasoning: ${proposal.reasoning ?? ""}</p>
    </div>`;
  }
  if (proposal.kind === "clarify") {
    return html`<div class="proposal">
      <p>Clarification requested: ${proposal.question ?? ""}</p>
    </div>`;
  }
  return html`<div class="proposal">
    <p>Declined: ${proposal.reason ?? ""}</p>
  </div>`;
}
