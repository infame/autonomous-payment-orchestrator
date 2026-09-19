/**
 * Public surface of `@apo/agent-orchestrator`. Steps 1-7 of the spec's
 * implementation order (docs/todo/03-agent-orchestrator.md §14) are in place
 * — the `Intent` domain aggregate + `AgentProposal`, the pure, deterministic
 * `policy/` guardrail layer, the `LlmClient` port with its directive-driven
 * `MockLlmClient` adapter and its live `AnthropicLlmClient` adapter, the
 * `AgentCoreClient` port, and the `IntentRepository` port with its Postgres
 * and in-memory adapters — plus step 6 in full: all five `app/*` use-cases,
 * `SubmitIntent`, `GetIntent`, `AnswerClarification`, `RejectIntent`, and
 * `ApproveIntent` — plus the first slice of step 8, a sixth use-case,
 * `SyncIntentExecution`: it reconciles an `executing` intent against
 * durable-ledger's actual workflow status, closing the gap left after
 * `ApproveIntent` where `Intent.complete`/`Intent.fail`/
 * `Intent.flagForReview` and `AgentCoreClient.getRunStatus` had no caller at
 * all, so an intent that reached `executing` would stay there forever. The
 * Hono HTTP layer, composition root, and `main.ts` that will call it are
 * still later slices of the same step (see below).
 *
 * `MockLlmClient` and its directive grammar ARE exported (unlike
 * `durable-ledger`'s test-only fakes) — `mock` is a real runtime mode for
 * the public demo (spec §5), not test-only infrastructure, matching how
 * `pay-core` exports `SimulatorProvider`. `AnthropicLlmClient` and
 * `createAnthropicClient` (`adapters/llm/anthropic-llm-client.ts`,
 * `anthropic-client.ts`) are exported for the same reason — `live` is a
 * real runtime mode too, even though nothing wires it up yet (see below).
 * The tool name constants and `SYSTEM_PROMPT` (`anthropic-tools.ts`,
 * `anthropic-prompt.ts`) are exported as well: an external consumer
 * composing its own `AnthropicMessagesApi` test double, or wanting to
 * assert against the real tool vocabulary/system prompt, otherwise has no
 * way to reach them.
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
 * doesn't export it either). Not exported because they don't exist yet: the
 * HTTP/Hono layer, composition root, and `main.ts` (step 8) — which is also
 * where `AgentCoreClient` gets wired into `ApproveIntent` behind a real
 * route, and where `AnthropicLlmClient` would first become reachable
 * end-to-end via `config.ts`'s `LLM_MODE` switch, once a composition root
 * actually reads it.
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
export * from "./app/sync-intent-execution.js";

// Adapters
export * from "./adapters/llm/directives.js";
export * from "./adapters/llm/mock-llm-client.js";
export * from "./adapters/llm/anthropic-client.js";
export * from "./adapters/llm/anthropic-tools.js";
export * from "./adapters/llm/anthropic-prompt.js";
export * from "./adapters/llm/anthropic-llm-client.js";
export * from "./adapters/http/durable-ledger-client.js";
export * from "./adapters/persistence/drizzle/schema.js";
export * from "./adapters/persistence/drizzle/pg-intent-repository.js";
export * from "./adapters/memory/in-memory-intent-repository.js";
