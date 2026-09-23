/**
 * The three demo scenarios (`00-overview §8`, `docs/todo/05-orchestra.md
 * §3`). Each is a pure async function: it drives `AgentOrchestratorClient`/
 * `DurableLedgerClient`, asserts invariants against the real responses, and
 * returns a typed `ScenarioResult` — no `console.log` here (that's
 * `narrate.ts`'s job), so `scenarios.test.ts` can assert on the result
 * directly against an in-process fake stack.
 *
 * Constraint F4 (`docs/todo/05-orchestra.md §3`): every intent text below is
 * free of reference/date numbers — `extractGroundedAmounts` grounds every
 * numeric literal in the text, so a stray "invoice #42" would ground 4200
 * minor units and corrupt the min/max amount selection this demo depends on.
 */
import type { AgentOrchestratorClient, IntentView } from "./client.js";
import type { DurableLedgerClient } from "./client.js";

export class ScenarioAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ScenarioAssertionError(message);
  }
}

export interface ScenarioBeat {
  readonly name: string;
  readonly detail?: string;
}

export type ScenarioId = "a" | "b" | "c";

export interface ScenarioResult {
  readonly id: ScenarioId;
  readonly title: string;
  readonly passed: boolean;
  readonly beats: readonly ScenarioBeat[];
  readonly failure?: string;
}

export interface ScenarioClients {
  readonly orchestrator: AgentOrchestratorClient;
  readonly ledger: DurableLedgerClient;
}

export interface ScenarioOptions {
  readonly customerId: string;
  readonly clients: ScenarioClients;
  /** How long to poll `GET /intents/:id` for a terminal status before giving up (scenario A only — it's the only scenario with a workflow to wait on). Default 60s: long enough for Inngest's retried `capture` (F3) under normal local-dev load. */
  readonly pollDeadlineMs?: number;
  /** Interval between `GET /intents/:id` polls (scenario A only). Default 500ms in production; `scenarios.test.ts` overrides it down for a fast, hermetic fake stack. */
  readonly pollIntervalMs?: number;
}

type BeatRecorder = (name: string, detail?: string) => void;

async function runScenario(
  id: ScenarioId,
  title: string,
  body: (record: BeatRecorder) => Promise<void>,
): Promise<ScenarioResult> {
  const beats: ScenarioBeat[] = [];
  const record: BeatRecorder = (name, detail) => {
    beats.push(detail !== undefined ? { name, detail } : { name });
  };
  try {
    await body(record);
    return { id, title, passed: true, beats };
  } catch (err) {
    if (err instanceof ScenarioAssertionError) {
      return { id, title, passed: false, beats, failure: err.message };
    }
    // A harness/connection error (DemoClientError et al.) is not a scenario
    // assertion failure — propagate so cli-main.ts's exit-code-3 path
    // catches it, distinct from exit-code-1's "an assertion failed".
    throw err;
  }
}

/** The intent text shared by scenarios A and B: an ambiguous invoice amount with no reference/date numbers (F4), routed to `needs_clarification` via `sim.clarify`. */
const AMBIGUOUS_INVOICE_TEXT =
  "Pay the vendor for the consulting invoice. The invoice header says $1,200.00 but the summary line says $1,250.00. sim.clarify";
const CLARIFICATION_ANSWER = "Use the invoice header amount, $1,200.00.";
const EXPECTED_AMOUNT_MINOR_UNITS = 120_000;

function requirePaymentProposal(
  view: IntentView,
): asserts view is IntentView & {
  proposal: { kind: "propose_payment"; amount: number; merchantId: string };
} {
  assert(
    view.proposal !== null && view.proposal.kind === "propose_payment",
    `expected a propose_payment proposal, got ${JSON.stringify(view.proposal)}`,
  );
}

/**
 * Scenario A — canonical (`00-overview §8` beats 1-6): ambiguous invoice →
 * clarify → policy approval gate → approve → durable retry (F3) →
 * completed, with ledger balance-delta evidence.
 */
export async function runScenarioA(
  options: ScenarioOptions,
): Promise<ScenarioResult> {
  return runScenario(
    "a",
    "canonical — ambiguous invoice, approval gate, durable retry, ledger evidence",
    async (record) => {
      const { orchestrator, ledger } = options.clients;
      const customerId = options.customerId;

      // Deliberately NO Idempotency-Key: auto-approve only fires on a keyed
      // submission that lands on "proposed" — omitting the key keeps this
      // beat routed through the human approval gate, per §8 beat 3 and
      // ADR-0015's own scoping.
      const submitted = await orchestrator.submitIntent({
        customerId,
        text: AMBIGUOUS_INVOICE_TEXT,
      });
      assert(
        submitted.status === 201,
        `expected 201 from POST /intents, got ${String(submitted.status)}`,
      );
      assert(
        submitted.intent.status === "needs_clarification",
        `expected needs_clarification, got "${submitted.intent.status}"`,
      );
      record(
        "submitted an ambiguous invoice",
        `id=${submitted.intent.id} status=${submitted.intent.status}`,
      );

      const clarified = await orchestrator.clarify(
        submitted.intent.id,
        customerId,
        CLARIFICATION_ANSWER,
      );
      assert(
        clarified.status === "needs_approval",
        `expected needs_approval after clarification, got "${clarified.status}"`,
      );
      requirePaymentProposal(clarified);
      assert(
        clarified.proposal.amount === EXPECTED_AMOUNT_MINOR_UNITS,
        `expected the min-selected amount ${String(EXPECTED_AMOUNT_MINOR_UNITS)}, got ${String(clarified.proposal.amount)}`,
      );
      record(
        "clarified — policy gated the proposal to needs_approval",
        `amount=${String(clarified.proposal.amount)} verdict=${JSON.stringify(clarified.policyVerdict)}`,
      );

      const merchantAccount = `merchant:${clarified.proposal.merchantId}`;
      const beforeMerchant = await ledger.getBalance(merchantAccount, "USD");
      const beforeClearing = await ledger.getBalance(
        "acquirer_clearing",
        "USD",
      );

      const approved = await orchestrator.approve(clarified.id, customerId);
      assert(
        approved.status === "executing",
        `expected executing after approve, got "${approved.status}"`,
      );
      assert(
        approved.durableLedgerEventId !== null,
        "expected a durableLedgerEventId after approve",
      );
      record(
        "approved — durable-ledger workflow started",
        `eventId=${approved.durableLedgerEventId}`,
      );

      const terminal = await orchestrator.pollUntilTerminal(
        approved.id,
        customerId,
        {
          deadlineMs: options.pollDeadlineMs ?? 60_000,
          ...(options.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.pollIntervalMs }
            : {}),
        },
      );
      assert(
        terminal.status === "completed",
        `expected completed, got "${terminal.status}" — capture's fail-once-then-succeed (F3) should have resolved via Inngest's retry`,
      );
      record(
        "workflow completed",
        "durable-ledger's capture step failed once and Inngest retried it (F3) before this resolved",
      );

      const afterMerchant = await ledger.getBalance(merchantAccount, "USD");
      const afterClearing = await ledger.getBalance("acquirer_clearing", "USD");
      const merchantDelta = afterMerchant - beforeMerchant;
      const clearingDelta = afterClearing - beforeClearing;
      assert(
        merchantDelta === EXPECTED_AMOUNT_MINOR_UNITS,
        `expected merchant balance to increase by ${String(EXPECTED_AMOUNT_MINOR_UNITS)}, got delta ${String(merchantDelta)}`,
      );
      assert(
        clearingDelta === -EXPECTED_AMOUNT_MINOR_UNITS,
        `expected acquirer_clearing balance to decrease by ${String(EXPECTED_AMOUNT_MINOR_UNITS)}, got delta ${String(clearingDelta)}`,
      );
      record(
        "ledger evidence — double-entry balanced",
        `merchant +${String(merchantDelta)}, acquirer_clearing ${String(clearingDelta)}`,
      );
      record(
        "Inngest dashboard (watch the retried capture step)",
        "http://localhost:8288",
      );
    },
  );
}

/**
 * Scenario B — cancellation, routed around F2 (`docs/todo/05-orchestra.md
 * §3`): the same setup as A through `needs_approval`, then an explicit
 * reject. No workflow is ever started and both ledger balances are
 * unchanged. This is deliberately NOT durable-ledger's saga compensation —
 * that path is proven in-process only
 * (`payment-execute-compensation.test.ts`) and is unreachable through the
 * live stack (F2). Do not dress this up as the saga; the narration must say
 * so honestly.
 */
export async function runScenarioB(
  options: ScenarioOptions,
): Promise<ScenarioResult> {
  return runScenario(
    "b",
    "cancellation — orchestrator-level reject before any money moves (NOT the durable-ledger saga — see F2)",
    async (record) => {
      const { orchestrator, ledger } = options.clients;
      const customerId = options.customerId;

      const submitted = await orchestrator.submitIntent({
        customerId,
        text: AMBIGUOUS_INVOICE_TEXT,
      });
      assert(
        submitted.intent.status === "needs_clarification",
        `expected needs_clarification, got "${submitted.intent.status}"`,
      );
      record(
        "submitted an ambiguous invoice",
        `id=${submitted.intent.id} status=${submitted.intent.status}`,
      );

      const clarified = await orchestrator.clarify(
        submitted.intent.id,
        customerId,
        CLARIFICATION_ANSWER,
      );
      assert(
        clarified.status === "needs_approval",
        `expected needs_approval after clarification, got "${clarified.status}"`,
      );
      requirePaymentProposal(clarified);
      record(
        "clarified — policy gated the proposal to needs_approval",
        `amount=${String(clarified.proposal.amount)}`,
      );

      const merchantAccount = `merchant:${clarified.proposal.merchantId}`;
      const beforeMerchant = await ledger.getBalance(merchantAccount, "USD");
      const beforeClearing = await ledger.getBalance(
        "acquirer_clearing",
        "USD",
      );

      const rejected = await orchestrator.reject(clarified.id, customerId);
      assert(
        rejected.status === "rejected",
        `expected rejected, got "${rejected.status}"`,
      );
      assert(
        rejected.durableLedgerEventId === null,
        "expected no durableLedgerEventId — no workflow should ever have started",
      );
      record(
        "rejected before approval — no workflow started",
        "honest framing: this is an orchestrator-level cancellation, not durable-ledger's saga compensation (F2 — the saga is proven in-process only, unreachable through the live stack today)",
      );

      const afterMerchant = await ledger.getBalance(merchantAccount, "USD");
      const afterClearing = await ledger.getBalance("acquirer_clearing", "USD");
      assert(
        afterMerchant === beforeMerchant,
        `expected merchant balance unchanged, got delta ${String(afterMerchant - beforeMerchant)}`,
      );
      assert(
        afterClearing === beforeClearing,
        `expected acquirer_clearing balance unchanged, got delta ${String(afterClearing - beforeClearing)}`,
      );
      record(
        "ledger evidence — both balances unchanged",
        "zero money moved for a rejected intent",
      );
    },
  );
}

/** The intent text for scenario C: a grounded amount plus `sim.amount.ungrounded`, which makes the mock propose one minor unit ABOVE the largest grounded candidate — a deliberately ungrounded proposal `amountMustBeGrounded` must reject regardless of magnitude. No reference/date numbers (F4). */
const UNGROUNDED_GUARDRAIL_TEXT =
  "Pay the vendor for the design retainer. The retainer is $500.00. sim.amount.ungrounded";

/**
 * Scenario C — guardrail: an ungrounded amount proposal must be rejected
 * outright, independent of magnitude, with zero core calls (no
 * `durableLedgerEventId`) and no ledger effect.
 */
export async function runScenarioC(
  options: ScenarioOptions,
): Promise<ScenarioResult> {
  return runScenario(
    "c",
    "guardrail — an ungrounded amount proposal is rejected, not executed",
    async (record) => {
      const { orchestrator, ledger } = options.clients;
      const customerId = options.customerId;
      const merchantAccount = "merchant:vendor";

      const beforeMerchant = await ledger.getBalance(merchantAccount, "USD");

      const submitted = await orchestrator.submitIntent({
        customerId,
        text: UNGROUNDED_GUARDRAIL_TEXT,
        idempotencyKey: `orchestra-demo-scenario-c-${customerId}`,
      });
      assert(
        submitted.intent.status === "rejected",
        `expected rejected, got "${submitted.intent.status}"`,
      );
      assert(
        submitted.intent.durableLedgerEventId === null,
        "expected no durableLedgerEventId — zero core calls for a rejected intent",
      );
      record(
        "submitted an ungrounded-amount proposal",
        `id=${submitted.intent.id} status=${submitted.intent.status} verdict=${JSON.stringify(submitted.intent.policyVerdict)}`,
      );

      const afterMerchant = await ledger.getBalance(merchantAccount, "USD");
      assert(
        afterMerchant === beforeMerchant,
        `expected merchant balance unchanged, got delta ${String(afterMerchant - beforeMerchant)}`,
      );
      record(
        "ledger evidence — unchanged",
        "the guardrail held before any core call was made",
      );
    },
  );
}

export const SCENARIOS: Record<
  ScenarioId,
  (options: ScenarioOptions) => Promise<ScenarioResult>
> = {
  a: runScenarioA,
  b: runScenarioB,
  c: runScenarioC,
};
