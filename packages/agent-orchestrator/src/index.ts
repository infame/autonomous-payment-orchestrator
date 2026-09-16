/**
 * Public surface of `@apo/agent-orchestrator`. Steps 1-5 of the spec's
 * implementation order (docs/todo/03-agent-orchestrator.md §14) are in place
 * — the `Intent` domain aggregate + `AgentProposal`, the pure, deterministic
 * `policy/` guardrail layer, the `LlmClient` port with its directive-driven
 * `MockLlmClient` adapter, the `AgentCoreClient` port, and the
 * `IntentRepository` port with its Postgres and in-memory adapters — plus the
 * first slice of step 6: the `SubmitIntent` and `GetIntent` use-cases.
 *
 * `MockLlmClient` and its directive grammar ARE exported (unlike
 * `durable-ledger`'s test-only fakes) — `mock` is a real runtime mode for
 * the public demo (spec §5), not test-only infrastructure, matching how
 * `pay-core` exports `SimulatorProvider`.
 *
 * Not exported: `db.ts`/`mappers.ts`/`errors.ts`/`migrator.ts`/
 * `run-migrate.ts`/`test-support.ts` (internal to the Postgres adapter,
 * matching `durable-ledger`'s convention). Not exported because they don't
 * exist yet: the `AnswerClarification`, `ApproveIntent`, `RejectIntent`
 * use-cases (rest of step 6); the HTTP/Hono layer; the composition root,
 * config, and `main.ts`; and `AgentCoreClient` wiring into a use-case
 * (step 8).
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
export * from "./app/submit-intent.js";
export * from "./app/get-intent.js";

// Adapters
export * from "./adapters/llm/directives.js";
export * from "./adapters/llm/mock-llm-client.js";
export * from "./adapters/http/durable-ledger-client.js";
export * from "./adapters/persistence/drizzle/schema.js";
export * from "./adapters/persistence/drizzle/pg-intent-repository.js";
export * from "./adapters/memory/in-memory-intent-repository.js";
