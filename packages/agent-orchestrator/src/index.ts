/**
 * Public surface of `@apo/agent-orchestrator`. Steps 1-3 of the spec's
 * implementation order (docs/todo/03-agent-orchestrator.md §14) — the
 * `Intent` domain aggregate + `AgentProposal`, the pure, deterministic
 * `policy/` guardrail layer, and the `LlmClient` port with its
 * directive-driven `MockLlmClient` adapter. No HTTP, no database.
 *
 * `MockLlmClient` and its directive grammar ARE exported (unlike
 * `durable-ledger`'s test-only fakes) — `mock` is a real runtime mode for
 * the public demo (spec §5), not test-only infrastructure, matching how
 * `pay-core` exports `SimulatorProvider`.
 *
 * Not exported, because they don't exist yet: `ports/intent-repository.ts`
 * (step 5), `app/*` use-cases (step 6), `adapters/llm/anthropic-llm-client.ts`,
 * Postgres/in-memory repositories (steps 5/7), `composition-root.ts`,
 * `config.ts`, `main.ts` (step 8).
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

// Use-cases

// Adapters
export * from "./adapters/llm/directives.js";
export * from "./adapters/llm/mock-llm-client.js";
export * from "./adapters/http/durable-ledger-client.js";
