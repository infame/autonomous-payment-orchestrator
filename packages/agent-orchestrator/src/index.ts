/**
 * Public surface of `@apo/agent-orchestrator`. Steps 1-8 of the spec's
 * implementation order (docs/todo/03-agent-orchestrator.md §14) are in place
 * — the `Intent` domain aggregate + `AgentProposal`, the pure, deterministic
 * `policy/` guardrail layer, the `LlmClient` port with its directive-driven
 * `MockLlmClient` adapter and its live `AnthropicLlmClient` adapter, the
 * `AgentCoreClient` port, and the `IntentRepository` port with its Postgres
 * and in-memory adapters — plus step 6 in full: all five `app/*` use-cases,
 * `SubmitIntent`, `GetIntent`, `AnswerClarification`, `RejectIntent`, and
 * `ApproveIntent` — plus all four of step 8's slices: a sixth use-case,
 * `SyncIntentExecution` (reconciles an `executing` intent against
 * durable-ledger's actual workflow status, closing the gap left after
 * `ApproveIntent` where `Intent.complete`/`Intent.fail`/
 * `Intent.flagForReview` and `AgentCoreClient.getRunStatus` had no caller at
 * all); `config.ts` (env-var parsing, not exported — see below); the Hono
 * HTTP layer (`adapters/http/app.ts`, `server-schemas.ts`,
 * `server-error-mapper.ts`) — `createAgentOrchestratorApp` wires the seven
 * use-cases behind `POST /intents`, `POST /intents/:id/{clarify,approve,
 * reject}`, `GET /intents/:id`, and `GET /healthz`, enforcing the
 * `X-Customer-Id` ownership check ADR-0014 decides; and the composition root
 * (`composition-root.ts`, below) that actually constructs real adapters —
 * `createAgentOrchestrator` (Postgres + `HttpDurableLedgerClient` +
 * mock-or-live `LlmClient`) and `createInMemoryAgentOrchestrator` (no
 * database, caller-supplied `AgentCoreClient`) — and calls
 * `createAgentOrchestratorApp` with them. Step 8 is complete.
 *
 * A seventh use-case, `AutoApproveIntent`, was added after step 8 shipped
 * — `Intent.autoApprove`'s first production caller, wired into `POST
 * /intents` behind an optional, caller-supplied `Idempotency-Key` header
 * (see [ADR-0015](../../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md)
 * and this file's own "Use-cases" section below for what's and isn't
 * exported from it).
 *
 * `MockLlmClient` and its directive grammar ARE exported (unlike
 * `durable-ledger`'s test-only fakes) — `mock` is a real runtime mode for
 * the public demo (spec §5), not test-only infrastructure, matching how
 * `pay-core` exports `SimulatorProvider`. `AnthropicLlmClient` and
 * `createAnthropicClient` (`adapters/llm/anthropic-llm-client.ts`,
 * `anthropic-client.ts`) are exported for the same reason — `live` is a
 * real runtime mode too, now wired end-to-end via `composition-root.ts`'s
 * `createLlmClient` and `config.ts`'s `LLM_MODE` switch. The tool name
 * constants and `SYSTEM_PROMPT` (`anthropic-tools.ts`, `anthropic-prompt.ts`)
 * are exported as well: an external consumer composing its own
 * `AnthropicMessagesApi` test double, or wanting to assert against the real
 * tool vocabulary/system prompt, otherwise has no way to reach them.
 *
 * Not exported: `db.ts`/`mappers.ts`/`errors.ts`/`migrator.ts`/
 * `run-migrate.ts`/`test-support.ts` (internal to the Postgres adapter,
 * matching `durable-ledger`'s convention); `adapters/http/
 * fake-durable-ledger-server.ts`, `adapters/memory/
 * fake-agent-core-client.ts`, and `adapters/llm/fake-anthropic-messages.ts`
 * (test support only — there is no legitimate runtime mode where this
 * package fakes the system that actually moves money or fakes the vendor
 * LLM's own SDK surface, unlike `InMemoryIntentRepository`/`MockLlmClient`
 * above). Not exported: `config.ts` is bootstrap-only, matching
 * `durable-ledger`'s own precedent (`packages/durable-ledger/src/index.ts`
 * doesn't export it either). `adapters/http/request.ts` is not exported
 * either — its `requireCustomerId`/`readJsonBody` are internal wiring for
 * `app.ts`, matching the same non-export convention both
 * `durable-ledger`'s and `pay-core`'s own `request.ts` already follow.
 * `main.ts` itself is also NOT exported, same rule `pay-core`'s and
 * `durable-ledger`'s own `main.ts` headers state — importing this package as
 * a library must never start a listener; `main.ts` is only ever run directly
 * (`node dist/main.js` / `pnpm start`). `app/derive-intent-id.ts`
 * (`deriveIntentId`/`uuidv5`/`INTENT_ID_NAMESPACE`) is also NOT exported —
 * it is an internal implementation detail of `SubmitIntent`'s idempotent-
 * submission path (ADR-0015); nothing outside `submit-intent.ts` imports it
 * in production code, and no external consumer has a legitimate reason to
 * derive an `Intent.id` itself rather than asking `SubmitIntent` to.
 */

// Domain
export * from "./domain/errors.js";
export * from "./domain/agent-proposal.js";
export * from "./domain/intent.js";

// Policy
export * from "./policy/verdict.js";
export * from "./policy/grounding.js";
export * from "./policy/rules.js";
export * from "./policy/evaluate-policy.js";

// Ports
export * from "./ports/llm-client.js";
export * from "./ports/agent-core-client.js";
export * from "./ports/intent-repository.js";

// Use-cases
export * from "./app/intent-view.js";
export * from "./app/apply-policy.js";
export * from "./app/submit-intent.js";
export * from "./app/get-intent.js";
export * from "./app/answer-clarification.js";
export * from "./app/reject-intent.js";
export * from "./app/approve-intent.js";
export * from "./app/auto-approve-intent.js";
export * from "./app/sync-intent-execution.js";

// Adapters
export * from "./adapters/llm/directives.js";
export * from "./adapters/llm/mock-llm-client.js";
export * from "./adapters/llm/anthropic-client.js";
export * from "./adapters/llm/anthropic-tools.js";
export * from "./adapters/llm/anthropic-prompt.js";
export * from "./adapters/llm/anthropic-llm-client.js";
export * from "./adapters/http/durable-ledger-client.js";
export * from "./adapters/http/app.js";
export * from "./adapters/http/server-schemas.js";
export * from "./adapters/http/server-error-mapper.js";
export * from "./adapters/persistence/drizzle/schema.js";
export * from "./adapters/persistence/drizzle/pg-intent-repository.js";
export * from "./adapters/memory/in-memory-intent-repository.js";

// Composition root
export * from "./composition-root.js";
