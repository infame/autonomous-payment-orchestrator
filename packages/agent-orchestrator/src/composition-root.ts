import type { Hono } from "hono";
import {
  createPool,
  createDb,
  type PgPool,
} from "./adapters/persistence/drizzle/db.js";
import { PgIntentRepository } from "./adapters/persistence/drizzle/pg-intent-repository.js";
import { InMemoryIntentRepository } from "./adapters/memory/in-memory-intent-repository.js";
import { HttpDurableLedgerClient } from "./adapters/http/durable-ledger-client.js";
import type { AgentCoreClient } from "./ports/agent-core-client.js";
import { MockLlmClient } from "./adapters/llm/mock-llm-client.js";
import { createAnthropicClient } from "./adapters/llm/anthropic-client.js";
import { AnthropicLlmClient } from "./adapters/llm/anthropic-llm-client.js";
import type { LlmClient } from "./ports/llm-client.js";
import type { IntentRepository } from "./ports/intent-repository.js";
import { resolvePolicyConfig, type PolicyConfig } from "./policy/rules.js";
import { SubmitIntent } from "./app/submit-intent.js";
import { GetIntent } from "./app/get-intent.js";
import { AnswerClarification } from "./app/answer-clarification.js";
import { ApproveIntent } from "./app/approve-intent.js";
import { RejectIntent } from "./app/reject-intent.js";
import { SyncIntentExecution } from "./app/sync-intent-execution.js";
import { createAgentOrchestratorApp } from "./adapters/http/app.js";

/**
 * Selects which `LlmClient` `createLlmClient` builds. `mode: "live"` needs
 * an `apiKey` + `model`; `mode: "mock"` needs nothing. Mirrors `config.ts`'s
 * `LLM_MODE` switch, one level up from raw env strings.
 */
export type LlmOptions =
  | { readonly mode: "mock" }
  | {
      readonly mode: "live";
      readonly apiKey: string;
      readonly model: string;
      readonly baseUrl?: string;
      readonly maxRetries?: number;
      readonly timeoutMs?: number;
    };

/**
 * Builds the configured `LlmClient`. `mode: "live"` goes through two
 * separate objects — `createAnthropicClient` (the only place a real API key
 * is ever handled) and `AnthropicLlmClient` (which only ever sees the narrow
 * `{ messages: { create } }` surface) — never the whole `Anthropic` client
 * or the key itself passed into `AnthropicLlmClient`. See
 * `anthropic-client.ts`/`anthropic-llm-client.ts` headers for why that
 * boundary matters.
 */
export function createLlmClient(options: LlmOptions): LlmClient {
  if (options.mode === "mock") {
    return new MockLlmClient();
  }
  const anthropicClient = createAnthropicClient({
    apiKey: options.apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.maxRetries !== undefined
      ? { maxRetries: options.maxRetries }
      : {}),
  });
  return new AnthropicLlmClient({
    // Narrowed to exactly the AnthropicMessagesApi surface via a closure,
    // not `anthropicClient.messages` directly: the SDK's own `Messages`
    // resource carries an internal `_client` back-reference to its owning
    // client (and therefore, transitively, the API key) — see
    // `anthropic-llm-client.ts`'s header and
    // `anthropic-llm-client.test.ts`'s canary test for why passing the
    // resource object itself would leak a live API key through the
    // `AgentOrchestrator.llm` field on any depth-unbounded dump.
    messages: {
      create: (params, options_) =>
        anthropicClient.messages.create(params, options_),
    },
    model: options.model,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

export interface CreateAgentOrchestratorOptions {
  readonly databaseUrl: string;
  readonly durableLedgerUrl: string;
  readonly durableLedgerTimeoutMs?: number;
  readonly paymentMethodToken: string;
  readonly llm: LlmOptions;
  readonly policy?: Partial<PolicyConfig>;
  readonly clock?: () => Date;
}

export interface AgentOrchestrator {
  readonly app: Hono;
  readonly intents: IntentRepository;
  readonly llm: LlmClient;
  readonly agentCore: AgentCoreClient;
  readonly policy: PolicyConfig;
  /** Closes the underlying connection pool. Call once on shutdown. */
  close(): Promise<void>;
}

/**
 * Shared wiring for both factories below: given already-built ports plus a
 * resolved `PolicyConfig`, builds the six `app/*` use-cases and the Hono
 * `app`. Kept as one module-private helper so `createAgentOrchestrator` and
 * `createInMemoryAgentOrchestrator` cannot silently drift apart on use-case
 * construction order/arity.
 */
function buildApp(
  intents: IntentRepository,
  llm: LlmClient,
  agentCore: AgentCoreClient,
  policy: PolicyConfig,
  clock: () => Date,
  paymentMethodToken: string,
): Hono {
  const submitIntent = new SubmitIntent(intents, llm, policy, clock);
  const getIntent = new GetIntent(intents);
  const answerClarification = new AnswerClarification(
    intents,
    llm,
    policy,
    clock,
  );
  const approveIntent = new ApproveIntent(
    intents,
    agentCore,
    paymentMethodToken,
    clock,
  );
  const rejectIntent = new RejectIntent(intents, clock);
  const syncIntentExecution = new SyncIntentExecution(
    intents,
    agentCore,
    clock,
  );

  return createAgentOrchestratorApp({
    submitIntent,
    getIntent,
    answerClarification,
    approveIntent,
    rejectIntent,
    syncIntentExecution,
  });
}

/**
 * Builds a ready-to-use agent-orchestrator service against real Postgres,
 * `durable-ledger` (over HTTP), and either the mock or live `LlmClient`: the
 * Hono `app`, the `IntentRepository`, the `LlmClient`, the `AgentCoreClient`,
 * and the resolved `PolicyConfig`. Mirrors `@apo/durable-ledger`'s
 * `createDurableLedger` and `@apo/pay-core`'s `createPayCore` in shape.
 *
 * `resolvePolicyConfig` is called explicitly here, even though `SubmitIntent`
 * and `AnswerClarification` each call it again internally on the SAME
 * `options.policy` value — deliberate, not redundant: it fails boot fast on
 * a bad policy config (rather than on the first request), and it guarantees
 * every consumer of the returned `policy` field sees the identical resolved
 * config the use-cases actually run against. See `config.ts`'s own comment
 * on `POLICY_ALLOWED_CURRENCIES` for why this call can't be skipped in favor
 * of the env-var-level checks alone.
 */
export function createAgentOrchestrator(
  options: CreateAgentOrchestratorOptions,
): AgentOrchestrator {
  // Both of these can throw synchronously (LlmConfigurationError / a bad
  // policy config) — run them before createPool so a boot-time throw never
  // leaves an unclosed pool behind.
  const llm = createLlmClient(options.llm);
  const policy = resolvePolicyConfig(options.policy);

  const pool: PgPool = createPool(options.databaseUrl);
  const intents = new PgIntentRepository(createDb(pool));

  const agentCore = new HttpDurableLedgerClient({
    baseUrl: options.durableLedgerUrl,
    ...(options.durableLedgerTimeoutMs !== undefined
      ? { timeoutMs: options.durableLedgerTimeoutMs }
      : {}),
  });

  const clock = options.clock ?? (() => new Date());

  const app = buildApp(
    intents,
    llm,
    agentCore,
    policy,
    clock,
    options.paymentMethodToken,
  );

  return {
    app,
    intents,
    llm,
    agentCore,
    policy,
    close: () => pool.end(),
  };
}

export interface CreateInMemoryAgentOrchestratorOptions {
  /** Required, no default/fake shipped — a caller supplies its own `AgentCoreClient` double (e.g. `FakeAgentCoreClient`, test-only). */
  readonly agentCore: AgentCoreClient;
  /** Defaults to `new MockLlmClient()` when omitted. */
  readonly llm?: LlmClient;
  /** Required, no hardcoded default. */
  readonly paymentMethodToken: string;
  readonly policy?: Partial<PolicyConfig>;
  readonly clock?: () => Date;
}

/**
 * Builds an agent-orchestrator `app` against the in-memory `IntentRepository`
 * adapter, for tests and local demos — no database, no `close()`. Shares
 * `buildApp` with `createAgentOrchestrator` above so the two factories'
 * use-case wiring cannot drift apart.
 */
export function createInMemoryAgentOrchestrator(
  options: CreateInMemoryAgentOrchestratorOptions,
): {
  readonly app: Hono;
  readonly intents: InMemoryIntentRepository;
  readonly llm: LlmClient;
  readonly agentCore: AgentCoreClient;
  readonly policy: PolicyConfig;
} {
  const intents = new InMemoryIntentRepository();
  const llm = options.llm ?? new MockLlmClient();
  const policy = resolvePolicyConfig(options.policy);
  const clock = options.clock ?? (() => new Date());

  const app = buildApp(
    intents,
    llm,
    options.agentCore,
    policy,
    clock,
    options.paymentMethodToken,
  );

  return { app, intents, llm, agentCore: options.agentCore, policy };
}
