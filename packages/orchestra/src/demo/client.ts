/**
 * HTTP-only clients the demo CLI drives the already-running docker-compose
 * stack with — one per upstream service, each with its OWN Zod schema for
 * the response fields it actually reads. No `workspace:*` import of any
 * sibling package (ADR-0020: `orchestra` talks to its siblings over HTTP
 * only, same rule ADR-0005/0011 already bind `durable-ledger`'s and
 * `agent-orchestrator`'s own HTTP clients to). These schemas are
 * deliberately narrower than each service's full wire contract — only the
 * fields this demo reads are validated; an upstream response is free to
 * carry more.
 */
import { z } from "zod";

/** Raised for a transport-level failure (network error, non-2xx the caller didn't expect, a response that fails its Zod schema). Distinct from a scenario assertion failure — see `cli-main.ts`'s exit-code table. */
export class DemoClientError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export interface DurableLedgerClientOptions extends HttpClientOptions {
  readonly serviceSecret: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function requestJson(
  baseUrl: string,
  timeoutMs: number,
  path: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(new URL(path, baseUrl), {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text();
    const body: unknown = text.trim() === "" ? undefined : JSON.parse(text);
    return { status: res.status, body };
  } catch (err) {
    throw new DemoClientError(
      `request to ${baseUrl}${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DemoClientError(
      `${context}: response did not match the expected shape — ${result.error.message}`,
    );
  }
  return result.data;
}

// --- agent-orchestrator ------------------------------------------------

const PaymentProposalView = z.object({
  kind: z.literal("propose_payment"),
  amount: z.number(),
  currency: z.string(),
  merchantId: z.string(),
  reasoning: z.string(),
});
const ClarifyProposalView = z.object({
  kind: z.literal("clarify"),
  question: z.string(),
});
const DeclineProposalView = z.object({
  kind: z.literal("decline"),
  reason: z.string(),
});
const ProposalView = z
  .union([PaymentProposalView, ClarifyProposalView, DeclineProposalView])
  .nullable();

const PolicyVerdictView = z
  .union([
    z.object({ decision: z.literal("allow") }),
    z.object({
      decision: z.literal("needs_approval"),
      reason: z.string(),
      detail: z.string(),
    }),
    z.object({
      decision: z.literal("reject"),
      reason: z.string(),
      detail: z.string(),
    }),
  ])
  .nullable();

export const IntentStatusSchema = z.enum([
  "received",
  "needs_clarification",
  "proposed",
  "needs_approval",
  "rejected",
  "executing",
  "completed",
  "failed",
  "needs_review",
]);
export type DemoIntentStatus = z.infer<typeof IntentStatusSchema>;

export const IntentView = z.object({
  id: z.string(),
  customerId: z.string(),
  text: z.string(),
  status: IntentStatusSchema,
  proposal: ProposalView,
  policyVerdict: PolicyVerdictView,
  durableLedgerEventId: z.string().nullable(),
  clarificationAnswer: z.string().nullable(),
});
export type IntentView = z.infer<typeof IntentView>;

const SubmitIntentResponse = z.object({
  intent: IntentView,
  verdict: PolicyVerdictView,
});
const MutateIntentResponse = z.object({ intent: IntentView });
const GetIntentResponse = z.object({ intent: IntentView });

export const TERMINAL_STATUSES: ReadonlySet<DemoIntentStatus> = new Set([
  "rejected",
  "completed",
  "failed",
  "needs_review",
]);

export interface SubmitIntentInput {
  readonly customerId: string;
  readonly text: string;
  readonly idempotencyKey?: string;
}

/**
 * Client for `@apo/agent-orchestrator`'s public HTTP surface — pointed at
 * either the mock instance directly (port 3200) or the `orchestra` gateway
 * (port 3300) depending on `--base-url`. Never throws on a well-formed
 * non-2xx response; callers inspect `.status` themselves (a scenario's own
 * assertions decide what's expected).
 */
export class AgentOrchestratorClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async submitIntent(
    input: SubmitIntentInput,
  ): Promise<{ status: number; intent: IntentView; verdict: unknown }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "X-Customer-Id": input.customerId,
    };
    if (input.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      "/intents",
      { method: "POST", headers, body: JSON.stringify({ text: input.text }) },
    );
    if (status >= 200 && status < 300) {
      const parsed = parseOrThrow(SubmitIntentResponse, body, "POST /intents");
      return { status, intent: parsed.intent, verdict: parsed.verdict };
    }
    throw new DemoClientError(
      `POST /intents returned unexpected status ${String(status)}: ${JSON.stringify(body)}`,
    );
  }

  async clarify(
    id: string,
    customerId: string,
    clarificationAnswer: string,
  ): Promise<IntentView> {
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      `/intents/${id}/clarify`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Customer-Id": customerId,
        },
        // Wire field is `answer` (`AnswerClarificationCommand` in
        // @apo/agent-orchestrator's app/answer-clarification.ts) — distinct
        // from `IntentView.clarificationAnswer`, the name the intent's own
        // STORED field takes once persisted. Verified against the running
        // stack, not just the source: an earlier `clarificationAnswer` body
        // key here 400'd with "answer: Required".
        body: JSON.stringify({ answer: clarificationAnswer }),
      },
    );
    if (status < 200 || status >= 300) {
      throw new DemoClientError(
        `POST /intents/${id}/clarify returned unexpected status ${String(status)}: ${JSON.stringify(body)}`,
      );
    }
    return parseOrThrow(MutateIntentResponse, body, "POST /intents/:id/clarify")
      .intent;
  }

  async approve(id: string, customerId: string): Promise<IntentView> {
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      `/intents/${id}/approve`,
      { method: "POST", headers: { "X-Customer-Id": customerId } },
    );
    if (status < 200 || status >= 300) {
      throw new DemoClientError(
        `POST /intents/${id}/approve returned unexpected status ${String(status)}: ${JSON.stringify(body)}`,
      );
    }
    return parseOrThrow(MutateIntentResponse, body, "POST /intents/:id/approve")
      .intent;
  }

  async reject(id: string, customerId: string): Promise<IntentView> {
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      `/intents/${id}/reject`,
      { method: "POST", headers: { "X-Customer-Id": customerId } },
    );
    if (status < 200 || status >= 300) {
      throw new DemoClientError(
        `POST /intents/${id}/reject returned unexpected status ${String(status)}: ${JSON.stringify(body)}`,
      );
    }
    return parseOrThrow(MutateIntentResponse, body, "POST /intents/:id/reject")
      .intent;
  }

  async getIntent(id: string, customerId: string): Promise<IntentView> {
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      `/intents/${id}`,
      { method: "GET", headers: { "X-Customer-Id": customerId } },
    );
    if (status < 200 || status >= 300) {
      throw new DemoClientError(
        `GET /intents/${id} returned unexpected status ${String(status)}: ${JSON.stringify(body)}`,
      );
    }
    return parseOrThrow(GetIntentResponse, body, "GET /intents/:id").intent;
  }

  /**
   * Polls `GET /intents/:id` until a terminal status or `deadlineMs` from
   * now elapses, sleeping `pollIntervalMs` between reads — drives the
   * demo's durable-retry beat (F3: `SyncIntentExecution`, called on every
   * `GET`, is what actually observes durable-ledger's retried `capture`).
   */
  async pollUntilTerminal(
    id: string,
    customerId: string,
    options: { readonly deadlineMs: number; readonly pollIntervalMs?: number },
  ): Promise<IntentView> {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const deadline = Date.now() + options.deadlineMs;
    for (;;) {
      const view = await this.getIntent(id, customerId);
      if (TERMINAL_STATUSES.has(view.status)) {
        return view;
      }
      if (Date.now() >= deadline) {
        throw new DemoClientError(
          `intent "${id}" did not reach a terminal status within ${String(options.deadlineMs)}ms (last status: ${view.status})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

// --- durable-ledger ------------------------------------------------------

const BalanceResponse = z.object({
  account: z.string(),
  currency: z.string(),
  balance: z.object({ amount: z.number(), currency: z.string() }),
});

/** Client for `@apo/durable-ledger`'s public HTTP surface — only the one read the demo needs, balance-by-account. */
export class DurableLedgerClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #serviceSecret: string;

  constructor(options: DurableLedgerClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#serviceSecret = options.serviceSecret;
  }

  /** `account` is the account's serialized form (`LedgerAccount.toString()`, e.g. `"merchant:vendor"` or `"acquirer_clearing"`) — encoded here, never by the caller. */
  async getBalance(account: string, currency: string): Promise<number> {
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      `/ledger/accounts/${encodeURIComponent(account)}/balance?currency=${encodeURIComponent(currency)}`,
      {
        method: "GET",
        headers: { "X-Service-Secret": this.#serviceSecret },
      },
    );
    if (status < 200 || status >= 300) {
      throw new DemoClientError(
        `GET /ledger/accounts/${account}/balance returned unexpected status ${String(status)}: ${JSON.stringify(body)}`,
      );
    }
    return parseOrThrow(
      BalanceResponse,
      body,
      "GET /ledger/accounts/:account/balance",
    ).balance.amount;
  }
}

// --- pay-core --------------------------------------------------------------

const HealthResponse = z.object({ status: z.literal("ok") });

/** Client for `@apo/pay-core`'s public HTTP surface — used only for the CLI's preflight liveness check (§ cli-main.ts), never called mid-scenario: the demo never talks to pay-core directly, only through durable-ledger's orchestration. */
export class PayCoreClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async checkHealth(): Promise<boolean> {
    const { status, body } = await requestJson(
      this.#baseUrl,
      this.#timeoutMs,
      "/healthz",
      { method: "GET" },
    );
    return status === 200 && HealthResponse.safeParse(body).success;
  }
}
