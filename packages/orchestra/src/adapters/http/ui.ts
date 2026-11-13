/**
 * Server-rendered HTML views (`hono/html`). Every interpolated value below
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
 * re-implemented) and redirects to the resulting HTML view on success.
 * Full-document navigation ensures meta refresh is applied on execution
 * and removed on terminal states. Forms and refresh links work without JS.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  PREPARED_CLARIFICATION,
  scenarioForText,
} from "./browser-scenarios.js";

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
  readonly clarificationAnswer?: string | null | undefined;
  readonly policyVerdict?:
    | { readonly decision: "allow" }
    | {
        readonly decision: "needs_approval" | "reject";
        readonly reason: string;
        readonly detail: string;
      }
    | null
    | undefined;
}

function formatAmount(amount: number, currency: string): string {
  // Minor units -> major, 2-decimal display only — matches this whole
  // system's 2-decimal minor-unit assumption (policy/rules.ts's
  // ZERO_DECIMAL_CURRENCIES comment in @apo/agent-orchestrator). Purely
  // cosmetic; never used for a money decision.
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/** Static styles only: untrusted content always uses the escaped html tag. */
const STYLE = raw(`<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#334155;background:#fff;line-height:1.6;font-size:16px}*{box-sizing:border-box}body{margin:0}main,header{max-width:1040px;margin:auto;padding:32px 24px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e2e8f0;padding-top:20px;padding-bottom:20px}a{color:#1d4ed8}h1,h2,h3,p{margin-top:0}h1{font-family:Georgia,serif;font-weight:400;font-size:clamp(2rem,5vw,3.3rem);line-height:1.15;color:#0f172a;max-width:760px;margin-bottom:20px}h2{font-size:1.2rem;color:#0f172a}h3{font-size:1.1rem;color:#0f172a;margin-bottom:8px}.intro{max-width:680px;margin-bottom:36px}.muted,small{color:#64748b}.banner{padding:12px 16px;background:#eff6ff;margin-bottom:24px}.banner-live{background:#fffbeb}.banner form{display:inline}.scenario{display:grid;grid-template-columns:1fr auto;gap:24px;padding:26px 0;border-top:1px solid #cbd5e1;align-items:center}.scenario p{max-width:640px;margin-bottom:8px}.scenario form{margin:0}button,.button{display:inline-block;border:0;border-radius:6px;padding:12px 18px;background:#1d4ed8;color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}button.secondary{color:#1e293b;background:#e2e8f0}button:disabled{opacity:.5;cursor:not-allowed}:focus-visible{outline:3px solid #2563eb;outline-offset:4px}textarea{display:block;width:100%;min-height:110px;padding:12px;font:inherit;border:1px solid #94a3b8;border-radius:6px;margin:8px 0 16px}label{font-weight:600}details{margin-top:32px;border-top:1px solid #cbd5e1;padding-top:18px}summary{cursor:pointer;font-weight:600}details form{margin-top:20px}.workspace{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:28px}.panel{border-top:3px solid #cbd5e1;padding-top:18px;min-width:0}.source{white-space:pre-wrap;overflow-wrap:anywhere}.proposal{background:#f8fafc;padding:20px;margin-bottom:20px}.amount{font-size:1.8rem;font-weight:600;color:#0f172a;margin-bottom:4px}.notice{padding:18px 20px;border-left:4px solid #2563eb;background:#eff6ff}.notice.good{border-color:#15803d;background:#f0fdf4}.notice.warn{border-color:#b45309;background:#fffbeb}.notice.bad,.error{border-color:#b91c1c;background:#fef2f2}.error{padding:20px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.actions form{margin:0}code{overflow-wrap:anywhere}.stage-strip{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0;padding:0;list-style:none}.stage-strip li{padding:6px 12px;border:1px solid #cbd5e1;border-radius:20px;font-size:.9rem}.stage-strip [aria-current="step"]{color:#fff;background:#0f172a;border-color:#0f172a}.signals{display:grid;grid-template-columns:1fr 1fr 1.5fr;border:1px solid #cbd5e1;margin:24px 0}.signal{padding:16px;min-width:0}.signal+.signal{border-left:1px solid #cbd5e1}.signal dt{font-size:.85rem;color:#64748b}.signal dd{margin:6px 0 0;font-weight:600;overflow-wrap:anywhere}.loader{display:inline-block;width:18px;height:18px;border:3px solid #bfdbfe;border-top-color:#1d4ed8;border-radius:50%;margin-right:10px;vertical-align:middle;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.loader{animation:none}}footer{margin-top:36px;color:#64748b;font-size:.9rem}@media(max-width:640px){main,header{padding:20px 16px}.scenario,.workspace{grid-template-columns:1fr;gap:16px}.scenario button{width:100%}.signals{grid-template-columns:1fr}.signal+.signal{border-left:0;border-top:1px solid #cbd5e1}header{flex-wrap:wrap}.actions{flex-direction:column}.actions button{width:100%}}

[hidden]{display:none!important}
.lab-page main,.lab-page header{max-width:1280px}
#experiment{background:#f5f7fb;padding:24px;border-radius:14px;min-width:0}
#experiment *{min-width:0}
#experiment h1{font:650 clamp(1.8rem,4vw,2.3rem)/1.15 system-ui,sans-serif;color:#17283b;margin-bottom:12px}
#experiment p,#experiment strong,#experiment small,#experiment button{overflow-wrap:anywhere}
#experiment .lab-heading{display:flex;justify-content:space-between;gap:24px;margin-bottom:20px}
#experiment .lab-heading p{max-width:700px;margin-bottom:0}
#experiment .invoice-fact{text-align:right;flex-shrink:0;color:#53667d;font-size:.8rem}
#experiment .invoice-fact strong{display:block;font-size:1.5rem;color:#17283b}
#experiment .lab-attacks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
#experiment .challenge-picker{margin:0}
#experiment .challenge-picker button{height:100%;width:100%;text-align:left;background:#fff;border:1px solid #dce4ed;color:#17283b;font-size:.9rem;padding:15px}
#experiment .challenge-picker button[aria-pressed="true"]{background:#e9eefc;border-color:#254bd5}
#experiment .challenge-picker small{display:block;font-weight:400;font-size:.75rem;margin-top:6px}
#experiment #client-message{margin:16px 0 24px}
#experiment #experiment-error{margin-bottom:20px}
#experiment .lab-scene{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1fr);gap:16px;align-items:stretch;margin:0 0 24px}
#experiment .lab-source,#experiment .lab-engine,#experiment .lab-destination{display:flex;flex-direction:column;justify-content:center;background:#fff;border:1px solid #dce4ed;border-radius:10px;padding:20px}
#experiment .lab-source strong{display:block;font-size:1.1rem;margin:8px 0}
#experiment .lab-source p{font-size:.85rem;white-space:pre-wrap;margin:0}
#experiment .lab-engine,#experiment .lab-destination{text-align:center;align-items:center}
#experiment .lab-engine>strong{color:#254bd5;font-size:1.8rem}
#experiment .lab-engine p{font-weight:600;margin:8px 0}
#experiment .lab-arrow{align-self:center;text-align:center;color:#53667d}
#experiment .lab-destination>strong{display:block;font-size:1.6rem;font-variant-numeric:tabular-nums;line-height:1.35;margin:10px 0}
#experiment .lab-destination p{font-size:.8rem;margin:0}
#experiment .status-indicator{display:inline-block;width:12px;height:12px;background:#94a3b8;border-radius:50%;margin-top:10px;flex-shrink:0}
#experiment .status-indicator.pending{background:#2563eb;box-shadow:0 0 0 5px #dbeafe}
#experiment .status-indicator.good{background:#15803d}
#experiment .status-indicator.bad{background:#b91c1c}
#experiment .status-indicator.warn{background:#b45309}
#experiment #pending-label{font-size:.8rem;color:#1d4ed8}
#experiment #pending-label:before{content:"";display:inline-block;width:12px;height:12px;border:2px solid #bfdbfe;border-top-color:#1d4ed8;border-radius:50%;margin-right:8px;animation:spin 1s linear infinite}
#experiment .lab-verdict{padding:18px 20px;background:#e9eefc;border-radius:10px}
#experiment .lab-verdict h2{margin-bottom:6px}
#experiment .lab-verdict p{margin:0}
#experiment #batch-status:not(:empty){margin-top:10px}
#experiment .lab-verdict.good{background:#e7f3ed;color:#156344}
#experiment .lab-verdict.bad{background:#faeaf0;color:#a02d44}
#experiment .lab-verdict.warn{background:#fff2d9;color:#81530c}
#experiment .lab-sources{font-size:.75rem;color:#53667d;margin:14px 0}
#experiment #request-reference{font-size:.8rem;overflow-wrap:anywhere;margin:16px 0}

#experiment details{margin-top:16px;padding-top:12px}
#experiment .panel{margin-top:24px}
#experiment .decision-panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin:0 0 24px}
#experiment .decision-panels .amount{font-size:1.4rem;overflow-wrap:anywhere}
#experiment #recorded-source,#experiment #recorded-answer{white-space:pre-wrap}
#experiment .log-filters{display:flex;gap:12px;flex-wrap:wrap}
#experiment .log-filters label{font-size:.8rem}
#experiment .log-filters select{display:block;max-width:100%;padding:6px;font:inherit;margin-top:4px}
#experiment .log-workbench{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:16px;margin-top:12px;align-items:start}
#experiment .attempt-list{list-style:none;max-height:360px;overflow:auto;margin:0;padding:4px}
#experiment .attempt-list:empty{padding:0}
#experiment .attempt-list li{padding:10px 12px;margin-bottom:6px;background:#f8fafc;border-left:3px solid #94a3b8}
#experiment .attempt-list li.failed{border-color:#b45309;background:#fffbeb}
#experiment .attempt-list li.succeeded{border-color:#254bd5}
#experiment .attempt-list li.started{border-color:#2563eb}
#experiment .attempt-list small{display:block}
#experiment .attempt-list button{background:transparent;color:inherit;text-align:left;padding:0;font-weight:500;width:100%}
#experiment .attempt-list button[aria-pressed="true"]{outline:2px solid #254bd5;outline-offset:4px}
#experiment pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;max-height:360px;overflow:auto}
#experiment #selected-attempt{background:#fff;padding:16px;margin:0;position:sticky;top:12px;max-height:440px;overflow:auto;border:1px solid #dce4ed;border-radius:8px}
#experiment .main-action{margin:20px 0;padding:16px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}
#experiment #test-assessment{margin-top:12px;border-top:1px solid currentColor;padding-top:12px}#experiment #test-assessment h3{margin-bottom:4px}#experiment .test-outcome.good{color:#156344}#experiment .test-outcome.warn{color:#81530c}#experiment #read-status{margin:12px 0 0;font-size:.9rem}
#experiment #baseline-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem}
#experiment .case-plan{border-left:3px solid #254bd5;padding:12px 16px;background:#fff;margin:0 0 20px;font-size:.85rem}
#experiment .case-plan h2{font-size:1rem;margin-bottom:8px}
#experiment .case-plan p{margin-bottom:8px}
#experiment .case-plan p:last-child{margin-bottom:0}
#experiment .evidence-fields{margin:12px 0;display:grid;gap:10px}
#experiment .evidence-fields>div{border-top:1px solid #e2e8f0;padding-top:8px}
#experiment .evidence-fields dt{font-size:.75rem;color:#53667d}
#experiment .evidence-fields dd{margin:3px 0 0;overflow-wrap:anywhere;font-size:.85rem}
#experiment .evidence-value{white-space:pre-wrap;padding:1px 3px;background:#edf2ff;color:#2448a0;border-radius:3px}
#experiment .evidence-value.error-code{background:#fff2d9;color:#81530c}
#experiment .evidence-value.matching{background:#e7f3ed;color:#156344}
#experiment .evidence-legend{display:flex;gap:8px;flex-wrap:wrap;font-size:.75rem;margin:12px 0}
#experiment .operation-badge{display:inline-block;font-size:.75rem;padding:2px 6px;background:#fff2d9;color:#81530c;border-radius:4px}
#experiment .operation-badge.returned{background:#edf2ff;color:#2448a0}
#experiment .delivery-rows{list-style:none;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}
#experiment .delivery-rows button{background:#fff;color:#334155;border:1px solid #dce4ed;width:100%;height:100%;text-align:left;padding:12px;font-weight:400;font-size:.8rem}
#experiment .delivery-rows button[aria-pressed="true"]{outline:2px solid #254bd5;outline-offset:1px}
#experiment .delivery-rows strong,#experiment .delivery-rows small{display:block}
#experiment .delivery-rows .verified{border-left:3px solid #15803d}
#experiment .delivery-rows .returned{border-left:3px solid #254bd5}
#experiment .delivery-rows .uncertain{border-left:3px solid #b45309}
#experiment #batch-receipts{max-height:300px;background:#fff;padding:12px}
#experiment .table-scroll{overflow-x:auto}
#experiment table{border-collapse:collapse;width:100%;font-size:.9rem}
#experiment th,#experiment td{text-align:left;border-bottom:1px solid #e2e8f0;padding:12px 8px;overflow-wrap:anywhere}
#experiment th:not(:first-child),#experiment td:not(:first-child){text-align:right}
#experiment #ledger-balance.good{color:#15803d}
#experiment #resend-result{margin-top:16px}
#experiment .delivery-chip{padding:4px 7px;margin:3px;font-size:.75rem;background:#dce4ed;color:#53667d}
#experiment .delivery-chip.returned{background:#edf2ff;color:#2448a0}
#experiment .delivery-chip.fulfilled{background:#e7f3ed;color:#156344}
#experiment .delivery-chip.unknown,#experiment .delivery-chip.not_attempted{background:#fff2d9;color:#81530c}
#experiment .delivery-chip.failed{background:#faeaf0;color:#a02d44}
@media(prefers-reduced-motion:reduce){#experiment #pending-label:before{animation:none}}
@media(max-width:1000px){#experiment .lab-scene{grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);grid-template-areas:"source source source" "engine arrow destination";gap:12px}#experiment .lab-source{grid-area:source}#experiment .lab-engine{grid-area:engine}#experiment .lab-destination{grid-area:destination}#experiment .lab-arrow:nth-child(2){display:none}#experiment .lab-arrow:nth-child(4){grid-area:arrow}#experiment .lab-source,#experiment .lab-engine,#experiment .lab-destination{padding:16px}#experiment .lab-attacks{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){#experiment .lab-scene{grid-template-columns:1fr;grid-template-areas:"source" "engine" "destination"}#experiment .lab-arrow:nth-child(4){display:none}#experiment .lab-heading{display:block}#experiment .invoice-fact{text-align:left;margin-top:16px}#experiment .log-workbench{grid-template-columns:1fr}#experiment .attempt-list,#experiment pre{max-height:300px}#experiment #selected-attempt{position:static;max-height:440px}#experiment .delivery-rows{grid-template-columns:1fr}#experiment .decision-panels{grid-template-columns:1fr;gap:0}}
@media(max-width:560px){#experiment{padding:16px}#experiment .lab-heading{gap:12px}#experiment .lab-verdict{padding:16px}}

.lab-page header,.lab-page main{max-width:1040px}
.lab-page main{padding-top:20px}
.lab-page .banner{padding:8px 0;background:transparent;margin-bottom:22px;font-size:.875rem;color:#475569}
#experiment{padding:0;border-radius:0;background:transparent}
#experiment .lab-heading{display:block;margin-bottom:28px}
#experiment .lab-heading p{max-width:65ch}
#experiment .main-steps{display:flex;flex-wrap:wrap;gap:24px 40px;align-items:start;margin:0 0 20px}
#experiment .main-steps>form,#experiment .main-steps>section{flex:1 1 280px}
#experiment .step-label,#experiment .main-action h2{font-size:1rem;font-weight:600;margin:0 0 10px;color:#17283b}
#experiment .primary-challenge button{width:auto;background:#1d4ed8;border:0;color:#fff;font-size:1rem;text-align:center;padding:12px 18px}
#experiment .primary-challenge button:disabled{background:#e2e8f0;color:#475569;opacity:1;border:1px solid #cbd5e1;cursor:default}
#experiment .main-action{padding:0;border:0;background:transparent;border-radius:0;margin:0}
#experiment .main-action p{font-size:.875rem;max-width:48ch;margin-bottom:12px}
#experiment #client-message:empty{display:none}
#experiment #client-message{font-size:.875rem;color:#475569;margin:0 0 20px}
#experiment .lab-verdict{border-radius:8px;padding:20px}
#experiment .lab-verdict h2{font-size:1.35rem;margin-bottom:8px}
#experiment .result-payment{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin-top:18px;padding-top:12px;border-top:1px solid currentColor;font-size:.875rem}
#experiment .result-payment strong{font-size:1.15rem;font-variant-numeric:tabular-nums}
#experiment .result-payment p{flex-basis:100%}
#experiment #duplicate-proof{border-top:0;padding:0;margin-top:20px}
#experiment #duplicate-proof h3{font-size:1rem}
#experiment #duplicate-proof p{margin:0 0 6px;font-size:.9rem}
#experiment .result-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
#experiment #recovery-help{font-size:.875rem;margin:10px 0 0;max-width:70ch}
#experiment .lab-attacks{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:16px}
#experiment .lab-attacks button{border-radius:8px}
#experiment .challenge-picker small{font-size:.875rem}
#experiment .demo-limits{font-size:.875rem;color:#475569;margin:28px 0 0}
#experiment .portfolio-links{display:flex;flex-wrap:wrap;gap:10px 24px;margin-top:20px;font-size:.9rem}
#experiment .portfolio-links a{min-height:44px;display:inline-flex;align-items:center;text-underline-offset:3px}
#experiment summary{min-height:44px;align-content:center}
#experiment button:hover:not(:disabled){filter:brightness(.94)}
#experiment .case-plan{border-left:0;border-top:1px solid #cbd5e1;background:transparent;padding:16px 0;margin:16px 0}
#experiment ::selection{background:#bfdbfe;color:#0f172a}
@media(max-width:700px){#experiment .main-steps{display:block}#experiment .main-action{margin-top:24px}#experiment .lab-attacks{grid-template-columns:1fr}#experiment .main-steps button,#experiment .result-actions button{width:100%}#experiment .result-actions{flex-direction:column}#experiment .lab-verdict{padding:16px}#experiment .lab-heading{margin-bottom:24px}#experiment h1{font-size:2rem}}

#experiment .exchange{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:28px;border-block:1px solid #cbd5e1;padding:20px 0;margin:0 0 24px}
#experiment .exchange h3{font-size:1rem;margin:0 0 10px}
#experiment .exchange code{font-size:.85rem;overflow-wrap:anywhere}
#experiment .exchange p{font-size:.9rem;margin:10px 0 0;max-width:65ch}
#experiment .exchange-response{border-left:1px solid #cbd5e1;padding-left:28px}
#experiment .exchange details{margin-top:12px;padding-top:8px}
#experiment .observed-state{margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0}
#experiment .observed-state h4{margin:0 0 6px;font-size:.95rem}
#experiment .observed-fields{display:grid;gap:12px;margin:14px 0 0}
#experiment .observed-fields dt{font-size:.8rem;color:#475569}
#experiment .observed-fields dd{font-size:.9rem;margin:2px 0 0;overflow-wrap:anywhere;white-space:pre-wrap}
#experiment #repeat-action-panel{margin:28px 0 20px;padding-top:20px;border-top:1px solid #cbd5e1}
#experiment #payment-record-id{overflow-wrap:anywhere;font-size:.8rem}
#experiment .demonstration{margin-top:24px}
#experiment .demonstration h3{font-size:1rem;margin-bottom:6px}
#experiment .demonstration p{font-size:.95rem;max-width:70ch;margin-bottom:0}
@media(max-width:700px){#experiment .exchange{grid-template-columns:1fr;gap:20px}#experiment .exchange-response{border-left:0;border-top:1px solid #e2e8f0;padding-left:0;padding-top:20px}#experiment #repeat-action-panel button{width:100%}}

/* A permanent workspace: asynchronous reads update values, not the page structure. */
.lab-page header,.lab-page main{max-width:1240px;padding-inline:20px}
.lab-page header{padding-block:8px;min-height:40px;font-size:14px}
.lab-page main{padding-block:8px 12px}
.lab-page .banner{font-size:14px;line-height:1.35;margin:0 0 6px;padding:0}
#experiment .lab-heading{margin:0 0 12px}
#experiment h1{font-size:28px;line-height:1.15;margin:0 0 4px}
#experiment .lab-heading p{max-width:none;font-size:14px;line-height:1.4;margin:0}
#experiment .demo-workspace{display:grid;grid-template-columns:minmax(0,.95fr) minmax(0,1.15fr);gap:24px;align-items:stretch}
#experiment .post-workspace{display:grid;grid-template-rows:minmax(190px,auto) minmax(210px,auto);align-content:start;gap:10px}
#experiment .post-experience{border:1px solid #cbd5e1;border-radius:8px;padding:10px;min-width:0}
#experiment .post-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;margin:0 0 6px}
#experiment .post-heading h2,#experiment .observation-heading h2{font-size:16px;line-height:1.3;margin:0;max-width:22ch}
#experiment button{border:1px solid transparent;min-height:44px;box-sizing:border-box;transition:none}
#experiment .primary-challenge button,#experiment .primary-challenge button:disabled{border-width:1px;border-style:solid;min-height:44px;white-space:nowrap;font-size:14px;padding:8px 12px}
#experiment .primary-challenge button{border-color:transparent}
#experiment .primary-challenge button:disabled{border-color:#cbd5e1}
#experiment #repeat-action{font-size:14px;padding:8px 12px;white-space:nowrap}
#experiment #repeat-action-panel{margin:0;padding:10px;border:1px solid #cbd5e1}
#experiment .repeat-mechanism{font-size:14px;line-height:1.35;margin:0 0 6px;min-height:38px}
#experiment .exchange{display:block;padding:0;margin:0;border:0}
#experiment .exchange-row{display:grid;grid-template-columns:68px minmax(0,1fr);gap:8px;align-items:start}
#experiment .exchange-row+.exchange-row{margin-top:6px}
#experiment .exchange h3{font-size:14px;line-height:1.4;margin:0;font-weight:600}
#experiment .exchange p{font-size:14px;line-height:1.35;margin:0;max-width:none}
#experiment .exchange code{font-size:14px;line-height:1.35;overflow-wrap:anywhere}
#experiment .exchange-response{border:0;padding:0;min-height:62px}
#experiment .reference-slot{min-height:19px;overflow-wrap:anywhere}
#experiment #create-response-reference{font-size:14px;line-height:1.35}
#experiment #create-request-meaning{min-height:19px}
#experiment #repeat-next{min-height:19px}
#experiment #batch-status{min-height:38px;margin:0;font-size:14px;line-height:1.35}
#experiment .observation-workspace{border:1px solid #cbd5e1;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
#experiment .observation-heading{display:flex;justify-content:space-between;align-items:center;gap:10px;min-height:44px}
#experiment .observation-heading .result-actions{display:flex;flex-wrap:nowrap;gap:6px;margin:0}
#experiment .observation-heading button{font-size:14px;padding:8px 10px;white-space:nowrap}
#experiment #recovery-action{min-width:143px}
#experiment #new-experiment-action{min-width:132px}
#experiment .observed-state{border:0;padding:0;margin:0}
#experiment #observed-read-path{display:block;min-height:19px;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
#experiment .observed-state .observation-read-status{font-size:14px;line-height:1.35;min-height:19px;margin:4px 0 6px}
#experiment .observed-fields{gap:6px;margin:0}
#experiment .observed-fields>div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px;min-height:19px}
#experiment .observed-fields dt,#experiment .observed-fields dd{font-size:14px;line-height:1.35;margin:0}
#experiment .observed-fields dd{min-height:19px}
#experiment .lab-verdict{border-radius:6px;padding:8px 10px;min-height:80px;position:relative}
#experiment .lab-verdict h3{font-size:16px;line-height:1.3;min-height:21px;margin:0 0 3px}
#experiment .result-payment{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;border:0;margin:0;padding:0;font-size:14px;line-height:1.35}
#experiment .result-payment strong{font-size:18px;line-height:1.25}
#experiment #actual-state{font-size:14px}
#experiment .payment-reference-slot{min-height:21px;padding-top:2px}
#experiment #payment-record-id{font-size:14px;line-height:1.35;margin:0;overflow-wrap:anywhere}
#experiment #pending-label{position:absolute;right:12px;bottom:8px;font-size:14px}
#experiment #pending-label:before{display:none}
#experiment #duplicate-proof{margin:0;padding:0;border:0;min-height:58px;display:grid;grid-template-columns:1fr 1fr;column-gap:12px}
#experiment #duplicate-proof h3,#experiment .demonstration h3{font-size:14px;line-height:1.3;margin:0 0 4px}
#experiment #duplicate-proof p{font-size:14px;line-height:1.35;margin:0;min-height:19px}
#experiment .demonstration{margin:0;min-height:56px}
#experiment .demonstration p{font-size:14px;line-height:1.35;margin:0;max-width:none;min-height:38px}
#experiment .utility-strip{display:flex;flex-wrap:wrap;align-items:center;gap:4px 18px;border-top:1px solid #cbd5e1;padding-top:6px;margin-top:10px;min-height:50px}
#experiment .utility-strip .utility-button{background:transparent;color:#1d4ed8;font-size:14px;font-weight:500;padding:6px 0;border-radius:0}
#experiment .utility-strip .demo-limits{font-size:14px;margin:0;color:#475569}#experiment .utility-strip a{font-size:14px;min-height:44px;display:inline-flex;align-items:center;text-underline-offset:3px}
#experiment .utility-panel{border-top:1px solid #cbd5e1;margin-top:14px;padding-top:16px}
#experiment .utility-panel h2{font-size:18px}
#experiment .utility-panel pre{max-height:none;overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:1000px){#experiment .demo-workspace{grid-template-columns:1fr}#experiment .post-workspace{grid-template-rows:auto auto}#experiment .post-experience{min-height:190px}#experiment .observation-workspace{min-height:420px}}
@media(max-width:700px){.lab-page header,.lab-page main{padding-inline:16px}#experiment .post-heading{flex-wrap:wrap}#experiment .post-heading button{width:auto}#experiment .primary-challenge button{width:auto}#experiment .observation-heading{flex-wrap:wrap}#experiment .observation-heading .result-actions{flex-wrap:wrap;flex-direction:row}#experiment .observation-heading button{width:auto}#experiment .exchange-row{grid-template-columns:64px minmax(0,1fr)}#experiment .exchange-response{border:0;padding:0}#experiment .observed-fields>div{grid-template-columns:60px minmax(0,1fr)}#experiment #pending-label{position:static}#experiment #repeat-action-panel button{width:auto}#experiment .utility-strip{gap:2px 16px}}

#experiment #duplicate-proof h3,#experiment #identity-comparison{grid-column:1/-1}#experiment .observed-fields>div:last-child{min-height:38px}
</style>`);

function modeBanner(mode: LlmMode, remainingCalls: number | null) {
  return mode === "mock"
    ? html`<div class="banner">
        Simulation: mock reasoning and payment provider. Real HTTP, PostgreSQL,
        Inngest workflows and ledger. No real money moves.
      </div>`
    : html`<div class="banner banner-live">
        Live mode — real
        model${remainingCalls === null ? "" : ` (${String(remainingCalls)} calls left)`}.
        Prepared scenarios require mock mode.
        <form method="post" action="/session/mock">
          <button class="secondary" type="submit">Back to mock</button>
        </form>
      </div>`;
}

async function layout(
  title: string,
  mode: LlmMode,
  remainingCalls: number | null,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  refresh?: { id: string; count: number },
) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} — Payment review</title>
        ${STYLE}
        ${refresh === undefined ? "" : html`<meta http-equiv="refresh" content="2;url=/intents/${encodeURIComponent(refresh.id)}?poll=${refresh.count}" />`}
      </head>
      <body class="${title === "Failure lab" ? "lab-page" : ""}">
        <header>
          <strong>APO / Failure lab</strong
          ><a href="https://infame.dev/">Back to portfolio</a>
        </header>
        <main>${modeBanner(mode, remainingCalls)}${body}</main>
      </body>
    </html>`;
}

const LAB_CHALLENGES = [
  {
    id: "duplicates",
    title: "Make one payment",
    detail:
      "First pay $500 once. A second button will let you retry that same payment ten times.",
  },
  {
    id: "temporary_failure",
    title: "Try a temporary failure",
    detail: "The payment provider fails temporarily, then recovers.",
  },
  {
    id: "inflated_amount",
    title: "Try an incorrect amount",
    detail: "The source is $500. The mock proposes $5,000. Policy decides.",
  },
  {
    id: "permanent_decline",
    title: "Try a refused payment",
    detail:
      "Try a $600 payment. The provider permanently declines; inspect the actual refusal.",
  },
] as const;
export function renderHome(mode: LlmMode, remainingCalls: number | null) {
  if (mode === "live")
    return layout(
      "Live payment request",
      mode,
      remainingCalls,
      html`<h1>Review a payment request</h1>
        <p>
          Submit a request using your active live grant, then review its
          proposal on the next page.
        </p>
        <form method="post" action="/ui/intents">
          <label for="live-intent-text">Payment request</label
          ><textarea id="live-intent-text" name="text" required>
Pay the vendor $1,200.00 for consulting.</textarea
          ><button type="submit">Submit request for review</button>
        </form>`,
    );
  return layout(
    "Failure lab",
    mode,
    remainingCalls,
    html`<div id="experiment" data-mode="${mode}">
        <div class="lab-heading">
          <h1>Try to make it pay twice.</h1>
          <p>
            APO is a payment prototype: an assistant proposes, independent
            policy decides, and a workflow executes and records the payment.
          </p>
        </div>
        <div class="demo-workspace">
          <div class="post-workspace">
            <section class="post-experience" aria-labelledby="create-title">
              <form
                class="challenge-picker primary-challenge post-heading"
                method="post"
                action="/ui/challenges"
              >
                <h2 id="create-title">1. Create one payment</h2>
                <input type="hidden" name="scenario" value="duplicates" />
                <button type="submit" data-challenge="duplicates">
                  Make one $500 payment
                </button>
              </form>
              <section
                id="creation-exchange"
                class="exchange"
                aria-label="Create payment request and response"
              >
                <div class="exchange-row">
                  <h3>Request</h3>
                  <div>
                    <p id="create-request-meaning">
                      Preset: one simulated $500 payment instruction.
                    </p>
                    <code>POST /ui/challenges</code>
                    <code id="create-request-body">scenario=duplicates</code>
                  </div>
                </div>
                <div class="exchange-row exchange-response">
                  <h3>Response</h3>
                  <div>
                    <p id="create-response-summary">Not sent yet.</p>
                    <div class="reference-slot">
                      <code id="create-response-reference"></code>
                    </div>
                  </div>
                </div>
              </section>
            </section>
            <section
              id="repeat-action-panel"
              class="post-experience"
              aria-labelledby="repeat-title"
            >
              <div class="post-heading">
                <h2 id="repeat-title">2. Repeat the same payment</h2>
                <button id="repeat-action" type="button" disabled>
                  Retry it 10 times
                </button>
              </div>
              <p class="repeat-mechanism">
                Reuse original keys for capture and ledger posting. These
                retries should return existing records, without a new charge,
                model proposal, or workflow.
              </p>
              <section
                id="repeat-exchange"
                class="exchange"
                aria-label="Repeat operations request and response"
              >
                <div class="exchange-row">
                  <h3>Request</h3>
                  <div>
                    <code id="repeat-request-path"
                      >POST /api/intents/:id/redeliver</code
                    >
                    <p id="repeat-next">First confirm the original payment.</p>
                  </div>
                </div>
                <div class="exchange-row exchange-response">
                  <h3>Response</h3>
                  <div>
                    <p id="repeat-response-summary">Not sent yet.</p>
                    <p id="batch-status"></p>
                  </div>
                </div>
              </section>
            </section>
          </div>
          <section
            id="main-result"
            class="observation-workspace experiment-results"
            aria-label="Experiment result"
          >
            <div class="observation-heading">
              <h2>Observed result</h2>
              <div class="result-actions">
                <button
                  id="recovery-action"
                  type="button"
                  class="secondary"
                  disabled
                >
                  Refresh evidence</button
                ><button
                  id="new-experiment-action"
                  type="button"
                  class="secondary"
                  disabled
                >
                  New experiment
                </button>
              </div>
            </div>
            <section id="observed-state" class="observed-state">
              <code id="observed-read-path"
                >GET /api/intents/:id + /evidence</code
              >
              <p
                id="observed-read-status"
                class="observation-read-status"
                role="status"
              >
                No request has been sent.
              </p>
              <dl id="observed-state-fields" class="observed-fields">
                <div>
                  <dt>Request</dt>
                  <dd id="observed-source">—</dd>
                </div>
                <div>
                  <dt>Proposal</dt>
                  <dd id="observed-proposal">—</dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd id="observed-policy">—</dd>
                </div>
              </dl>
            </section>
            <section id="lab-verdict-panel" class="lab-verdict" role="status">
              <h3 id="lab-verdict">Ready for the first payment</h3>
              <div class="result-payment">
                <span>Captured</span><strong id="actual-amount">—</strong
                ><span id="actual-state">No observation yet</span>
              </div>
              <div class="payment-reference-slot">
                <p id="payment-record-id"></p>
              </div>
              <span id="pending-label" class="pending-label" hidden
                >Reading confirmation…</span
              >
            </section>
            <section id="duplicate-proof" class="proof-summary">
              <h3>Before → after the ten retries</h3>
              <p id="before-repeats">No baseline yet.</p>
              <p id="after-repeats">Repeats not tested.</p>
              <p id="identity-comparison">Ten matching receipts are needed.</p>
            </section>
            <section id="demonstration-panel" class="demonstration">
              <h3>What this demonstrates</h3>
              <p id="demonstration-meaning">
                Run the two explicit steps to compare payment and ledger
                identities.
              </p>
            </section>
          </section>
        </div>
        <nav class="utility-strip" aria-label="Project tools and sources">
          <button
            type="button"
            class="utility-button"
            data-utility-panel="exchange-details"
            aria-controls="exchange-details"
            aria-expanded="false"
          >
            Request / response JSON
          </button>
          <button
            type="button"
            class="utility-button"
            data-utility-panel="evidence-details"
            aria-controls="evidence-details"
            aria-expanded="false"
          >
            Inspect evidence
          </button>
          <button
            type="button"
            class="utility-button"
            data-utility-panel="other-tests"
            aria-controls="other-tests"
            aria-expanded="false"
          >
            Other tests
          </button>
          <a href="https://infame.dev/projects/autonomous-payment-orchestrator"
            >Case study</a
          >
          <a href="https://github.com/infame/autonomous-payment-orchestrator"
            >Source</a
          >
          <a href="https://infame.dev/">Portfolio</a>
          <span class="demo-limits"
            >Sequential simulation; not a load test.</span
          >
        </nav>
        <section id="exchange-details" class="utility-panel" hidden>
          <h2>Request and response fields</h2>
          <p>
            Returned fields are projections of actual response bodies. GET
            observations are separate from POST acknowledgements.
          </p>
          <section id="create-response-disclosure">
            <h3>Returned acknowledgement fields</h3>
            <pre id="create-response-raw"></pre>
          </section>
          <section id="repeat-response-disclosure">
            <h3>Actual repeat request</h3>
            <pre id="repeat-request-raw">No repeat request sent.</pre>
            <h3>Returned batch response fields</h3>
            <p>
              Repeats capture and ledger posting with original keys; no new
              instruction, model proposal, or workflow. This POST has no request
              body.
            </p>
            <pre id="repeat-response-raw"></pre>
          </section>
          <h3>Recorded baseline before retries</h3>
          <pre id="baseline-raw">No baseline yet.</pre>
        </section>
        <section id="other-tests" class="utility-panel" hidden>
          <h2>Other tests</h2>
          <p>Each test starts a new, isolated simulation.</p>
          <div class="lab-attacks">
            ${LAB_CHALLENGES.filter((c) => c.id !== "duplicates").map(
              (c) =>
                html`<form
                  class="challenge-picker"
                  method="post"
                  action="/ui/challenges"
                >
                  <input type="hidden" name="scenario" value="${c.id}" /><button
                    type="submit"
                    data-challenge="${c.id}"
                  >
                    <strong>${c.title}</strong><small>${c.detail}</small>
                  </button>
                </form>`,
            )}
          </div>
        </section>
        <section id="evidence-details" class="utility-panel" hidden>
          <h2>Payment and ledger evidence</h2>
          <p id="client-message" role="status">No experiment has run yet.</p>
          <div
            id="experiment-error"
            class="notice bad"
            role="alert"
            hidden
          ></div>
          <p id="read-status" role="status" hidden></p>
          <p id="recovery-help" class="muted">
            Reads the current state. Does not send another payment or repeat
            request.
          </p>
          <p id="lab-explanation"></p>

          <section
            class="case-plan"
            aria-label="Expected and observed experiment"
          >
            <h2 id="case-title">Experiment details</h2>
            <p><strong>Expected:</strong> <span id="case-expected"></span></p>
            <p id="invoice-fact" class="muted">
              <span id="source-invoice-label">Source invoice</span>
              <strong id="source-invoice-amount">$500 USD</strong>
            </p>
            <p>
              <span id="lab-incoming"></span>:
              <span id="lab-source-text"></span>
            </p>
            <p id="experiment-status"></p>
            <span id="status-indicator" class="status-indicator" hidden></span>
            <div id="delivery-chips"></div>
            <div id="test-assessment" hidden>
              <h3 id="test-assessment-label"></h3>
              <p id="test-assessment-detail"></p>
            </div>
          </section>
          <section id="journal-panel" class="panel">
            <h3>Recorded operations <span id="attempt-count">0</span></h3>
            <p id="journal-state" class="muted">
              Payment-service calls and local ledger work. History may be
              incomplete. Select a row for details.
            </p>
            <div class="log-filters">
              <label
                >Step<select id="log-step">
                  <option value="all">All steps</option>
                  <option value="authorize">Authorize</option>
                  <option value="capture">Capture</option>
                  <option value="post-ledger">Ledger posting</option>
                </select></label
              ><label
                >Outcome<select id="log-outcome">
                  <option value="all">All outcomes</option>
                  <option value="succeeded">Returned</option>
                  <option value="failed">Operation error</option>
                  <option value="started">In progress / unknown</option>
                </select></label
              ><label
                >Phase<select id="log-phase">
                  <option value="all">All phases</option>
                  <option value="workflow">Original workflow</option>
                  <option value="resend">Repeat requests</option>
                </select></label
              >
            </div>

            <p class="evidence-legend" aria-label="Evidence color legend">
              <span class="operation-badge returned"
                >Blue: returned or identifying fields</span
              >
              <span class="operation-badge">Amber: error or unknown</span>
              <span class="evidence-value matching"
                >Green: verified identity match</span
              >
            </p>
            <div class="log-workbench">
              <div>
                <p id="log-summary" class="muted">
                  Showing 0 of 0 recorded operations
                </p>
                <button id="reset-log-filters" type="button" class="secondary">
                  Show all operations
                </button>
                <p id="log-empty">No recorded operations yet.</p>
                <ol id="attempt-list" class="attempt-list"></ol>
              </div>
              <section
                id="selected-attempt"
                tabindex="0"
                aria-label="Selected operation"
              >
                <h4 id="operation-title">Select a recorded operation</h4>
                <p id="operation-purpose">
                  Choose a row to see what it did and how it ended.
                </p>
                <p id="operation-outcome"></p>
                <dl id="operation-fields" class="evidence-fields"></dl>
                <h4>Current related evidence</h4>
                <p>
                  This is the latest payment snapshot and ledger state, not the
                  historical response to this operation.
                </p>
                <dl id="operation-related" class="evidence-fields"></dl>
                <details id="operation-raw-disclosure">
                  <summary>Complete recorded operation JSON</summary>
                  <pre id="operation-raw">No selection.</pre>
                </details>
              </section>
            </div>
          </section>
          <section id="repeat-delivery-section" class="panel" hidden>
            <h3>Ten repeat deliveries, individually explained</h3>
            <p id="receipt-provenance">
              Each receipt below comes from the batch response for that
              delivery. Journal rows are separate observations and cannot be
              assigned to individual deliveries.
            </p>
            <ol id="delivery-rows" class="delivery-rows"></ol>
            <p id="batch-selection" tabindex="-1">No batch attempted.</p>
            <dl id="receipt-fields" class="evidence-fields"></dl>
            <details id="receipt-raw-disclosure">
              <summary>Complete selected delivery JSON</summary>
              <pre id="batch-receipts" tabindex="-1">No batch attempted.</pre>
            </details>
          </section>
          <div id="decision-panels" class="decision-panels">
            <section class="panel">
              <h3>
                ${mode === "mock" ? "Simulated assistant proposal" : "Assistant proposal"}
              </h3>
              <p id="proposal-amount" class="amount">—</p>
              <p id="proposal-description">No proposal yet.</p>
              <div class="recorded-source">
                <h4>Recorded source</h4>
                <p id="recorded-source"></p>
                <p id="recorded-answer"></p>
              </div>
            </section>
            <section class="panel">
              <h3>Policy decision</h3>
              <p id="policy-decision" class="amount">—</p>
              <p id="policy-explanation"></p>
            </section>
          </div>
          <section id="ledger-panel" class="panel">
            <h3>One payment, two accounting sides</h3>
            <p>
              Debit and credit balance to net zero because they record opposite
              accounting sides of one payment. Net zero does not mean nothing
              was charged. The captured amount is shown separately above.
            </p>
            <strong id="ledger-balance">No evidence yet</strong>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Debit</th>
                    <th>Credit</th>
                  </tr>
                </thead>
                <tbody id="ledger-rows"></tbody>
              </table>
            </div>
            <div>
              <h4>Entry identities</h4>
              <pre id="ledger-ids">No entries</pre>
            </div>
          </section>
          <section class="technical-notes">
            <h4>Technical test plan and observed counts</h4>
            <p id="case-mechanics"></p>
            <p id="case-observed-technical"></p>
            <p id="journal-provenance" class="muted"></p>
          </section>
          <details id="backend-state-disclosure">
            <summary>Technical backend state and exact policy verdict</summary>
            <p>
              USD amounts are in cents: 50000 = $500.00. This explains units,
              not a policy setting.
            </p>
            <pre id="backend-state-raw">No backend state yet.</pre>
          </details>
          <p id="request-reference" class="muted"></p>

          <p class="lab-sources">
            Captured amount: pay-core. Recorded entries: ledger. Workflow:
            Inngest.
          </p>
        </section>
        <noscript
          ><p>
            Initial payment submissions open a standalone result without
            JavaScript. The separate ten-repeat test requires JavaScript.
          </p></noscript
        >
      </div>
      <script type="module" src="/public/experiment-client.js"></script>`,
  );
}

function outcome(view: IntentDetailView) {
  switch (view.status) {
    case "needs_clarification":
      return {
        tone: "warn",
        title: "Which amount should be used?",
        text: "The request needs clarification before a payment can be reviewed.",
      };
    case "needs_approval":
      return {
        tone: "warn",
        title: "Your approval is required",
        text: "Review the source, proposal and policy decision. Approve to start execution, or reject to stop here.",
      };
    case "executing":
      return {
        tone: "",
        title: "Payment is executing",
        text: "The backend has started the workflow. Completion has not been confirmed yet.",
      };
    case "completed":
      return {
        tone: "good",
        title: "Payment completed",
        text: "The backend reports that execution completed. This page does not inspect retry attempts or ledger balances.",
      };
    case "rejected":
      return view.policyVerdict?.decision === "reject"
        ? {
            tone: "bad",
            title: "Policy blocked the proposal",
            text: "The proposal failed a policy check. Review the actual reason below.",
          }
        : {
            tone: "warn",
            title: "Payment rejected",
            text:
              view.policyVerdict?.decision === "needs_approval" &&
              view.durableLedgerEventId === null
                ? "The proposal reached human review and was rejected before execution."
                : "The backend reports rejection. No policy rejection reason is available.",
          };
    case "needs_review":
      return {
        tone: "warn",
        title: "Manual review is required",
        text: "The backend cannot confirm a final outcome automatically. An operator must inspect the workflow before taking further action.",
      };
    case "failed":
      return {
        tone: "bad",
        title: "Execution failed",
        text: "The backend reports a failure. Completion is not confirmed; refresh to check the current state.",
      };
    case "proposed":
      return {
        tone: "",
        title: "Proposal recorded",
        text: "This permitted proposal is saved, but execution has not started. A low-value clarification needs the original keyed submission to continue. This standalone page cannot resume that submission; do not assume refreshing starts a payment.",
      };
    default:
      return {
        tone: "warn",
        title: "State needs inspection",
        text: "The backend returned an unfamiliar status. Refresh to check again; no successful outcome is assumed.",
      };
  }
}

/** Explain the actual backend reason without interpreting numeric limit details. */
function explainPolicyReason(reason: string): string {
  switch (reason) {
    case "above_auto_approve_threshold":
      return "This amount requires your approval before payment can start.";
    case "amount_not_grounded":
      return "The proposed amount does not appear in the source request or accepted clarification.";
    case "merchant_not_grounded":
      return "The proposed recipient is not supported by the source request or accepted clarification.";
    case "currency_not_allowed":
      return "The proposed currency is not allowed by the payment policy.";
    case "hard_limit_exceeded":
      return "The proposed amount exceeds the payment policy's maximum limit.";
    case "daily_rate_limit_exceeded":
      return "The payment policy's daily request limit has been reached.";
    default:
      return "The backend returned a policy objection. Inspect the technical details for its exact reason.";
  }
}

export function renderIntentDetail(
  view: IntentDetailView,
  mode: LlmMode,
  remainingCalls: number | null,
  pollCount = 0,
) {
  const scenario = mode === "mock" ? scenarioForText(view.text) : undefined;
  const state = outcome(view);
  const stage =
    view.status === "rejected"
      ? view.policyVerdict?.decision === "reject"
        ? "Policy"
        : "Your review"
      : view.status === "needs_clarification"
        ? "Assistant"
        : view.status === "needs_approval"
          ? "Your review"
          : view.status === "executing"
            ? "Execution"
            : ["completed", "failed", "needs_review"].includes(view.status)
              ? "Outcome"
              : "Assistant";
  const path = `/ui/intents/${encodeURIComponent(view.id)}`;
  return layout(
    scenario?.title ?? "Payment request",
    mode,
    remainingCalls,
    html` <p><a href="/">Back to scenarios</a></p>
      <h1>${scenario?.title ?? "Review this payment"}</h1>
      <nav aria-label="Current backend stage">
        <ul class="stage-strip">
          ${["Source", "Assistant", "Policy", "Your review", "Execution", "Outcome"].map((label) => html`<li aria-current="${label === stage ? "step" : "false"}">${label}</li>`)}
        </ul>
      </nav>
      <section class="notice ${state.tone}" role="status">
        <h2>
          ${view.status === "executing" ? html`<span class="loader" aria-hidden="true"></span>` : ""}${state.title}
        </h2>
        <p>${state.text}</p>
        <small>Backend status: <strong>${view.status}</strong></small>
        ${view.status === "executing" ? html`<p>${pollCount < 30 ? "Waiting for backend confirmation. Checking automatically every 2 seconds for up to one minute. You can also refresh manually." : "Automatic checks paused. The workflow may still be running. Refresh manually to check again."}</p>` : ""}
        ${["executing", "failed", "proposed"].includes(view.status) || !["completed", "rejected", "needs_clarification", "needs_approval"].includes(view.status) ? html`<p><a href="/intents/${encodeURIComponent(view.id)}?poll=30">Refresh status</a></p>` : ""}
      </section>
      <dl class="signals" aria-label="Live backend evidence">
        <div class="signal">
          <dt>Current status</dt>
          <dd>${view.status}</dd>
        </div>
        <div class="signal">
          <dt>Policy verdict</dt>
          <dd>${view.policyVerdict?.decision ?? "Not available"}</dd>
        </div>
        <div class="signal">
          <dt>Workflow reference</dt>
          <dd>${view.durableLedgerEventId ?? "No workflow reference"}</dd>
        </div>
      </dl>
      <div class="workspace">
        <section class="panel">
          <h2>Source request</h2>
          ${
            scenario
              ? html`<p class="amount">
                    ${scenario.id === "clarify-and-pay" ? "$1,200.00 or $1,250.00" : scenario.id === "decline-payment" ? "$1,200.00" : "$500.00"}
                  </p>
                  <p class="muted">Amount in the source</p>`
              : ""
          }
          <p class="source">${view.text}</p>
          ${
            view.clarificationAnswer
              ? html`<h3>Your clarification</h3>
                  <p>${view.clarificationAnswer}</p>`
              : ""
          }
          ${
            scenario
              ? html`<details>
                  <summary>How this scenario is prepared</summary>
                  <p>
                    The source is a fixed mock fixture. Simulation directives,
                    if present above, select deterministic reasoning. The
                    suggested clarification selects $1,200; the mock does not
                    interpret freeform answers.
                  </p>
                  <p>
                    The default demo stack injects a temporary provider failure.
                    This page observes final backend status, not retry counts or
                    ledger entries.
                  </p>
                </details>`
              : ""
          }
        </section>
        <section class="panel">
          <h2>Assistant proposal</h2>
          ${renderProposal(view.proposal)}
          <h2>Policy decision</h2>
          ${
            view.policyVerdict
              ? html`<p><strong>${view.policyVerdict.decision}</strong></p>
                  ${
                    view.policyVerdict.decision === "allow"
                      ? html`<p>The policy allows this proposal.</p>`
                      : html`<p>
                            ${explainPolicyReason(view.policyVerdict.reason)}
                          </p>
                          <details>
                            <summary>Technical policy details</summary>
                            <p>
                              Raw backend detail; numeric amounts are in minor
                              units (for example, cents for USD).
                            </p>
                            <p>${view.policyVerdict.detail}</p>
                            <p><code>${view.policyVerdict.reason}</code></p>
                          </details>`
                  }`
              : html`<p>No policy verdict is available yet.</p>`
          }
        </section>
      </div>
      ${
        view.status === "needs_clarification"
          ? html`<section class="panel">
              <h2>Next: clarify the amount</h2>
              <form method="post" action="${path}/clarify">
                <label for="answer">Clarification answer</label
                ><textarea
                  id="answer"
                  name="answer"
                  required
                  ${scenario !== undefined ? html`readonly` : ""}
                >
${scenario ? PREPARED_CLARIFICATION : ""}</textarea
                ><button type="submit">
                  ${scenario ? "Use $1,200.00" : "Send clarification"}
                </button>
              </form>
            </section>`
          : ""
      }
      ${
        view.status === "needs_approval"
          ? html`<p>
                ${scenario?.id === "decline-payment" ? "Next: reject this payment to see how human review stops execution." : "Next: approve the reviewed proposal to start execution, or reject it."}
              </p>
              <div class="actions">
                <form method="post" action="${path}/approve">
                  <button type="submit">Approve payment</button>
                </form>
                <form method="post" action="${path}/reject">
                  <button class="secondary" type="submit">
                    Reject payment
                  </button>
                </form>
              </div>`
          : ""
      }
      <footer>
        Request
        <code>${view.id}</code
        >${view.durableLedgerEventId ? html`<br />Workflow reference: <code>${view.durableLedgerEventId}</code>` : ""}
      </footer>`,
    view.status === "executing" && pollCount < 30
      ? { id: view.id, count: pollCount + 1 }
      : undefined,
  );
}

export function renderErrorPage(
  message: string,
  mode: LlmMode,
  remainingCalls: number | null,
  retryPath?: string,
) {
  return layout(
    "Action unavailable",
    mode,
    remainingCalls,
    html`<p><a href="/">Back to scenarios</a></p>
      <div class="error">
        <h1>Could not complete that action.</h1>
        <p>${message}</p>
        <p>No successful outcome is assumed.</p>
        ${retryPath ? html`<p><a href="${retryPath}">Retry loading this payment</a></p>` : html`<p>Return to the scenarios to try again.</p>`}
      </div>`,
  );
}

function renderProposal(proposal: IntentProposalView | null) {
  if (proposal === null) return html`<p>No proposal yet.</p>`;
  if (proposal.kind === "propose_payment")
    return html`<div class="proposal">
      <p class="amount">
        ${proposal.amount === undefined || proposal.currency === undefined ? "Amount unavailable" : formatAmount(proposal.amount, proposal.currency)}
      </p>
      <p>To ${proposal.merchantId ?? "unknown recipient"}</p>
      <p>${proposal.reasoning ?? ""}</p>
    </div>`;
  if (proposal.kind === "clarify")
    return html`<div class="proposal"><p>${proposal.question ?? ""}</p></div>`;
  return html`<div class="proposal">
    <p>Assistant declined: ${proposal.reason ?? ""}</p>
  </div>`;
}
