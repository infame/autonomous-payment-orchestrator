/**
 * Public surface of `@apo/agent-orchestrator`. Steps 1-2 of the spec's
 * implementation order (docs/todo/03-agent-orchestrator.md §14) — the
 * `Intent` domain aggregate + `AgentProposal`, and the pure, deterministic
 * `policy/` guardrail layer. No LLM, no HTTP, no database.
 *
 * Not exported, because they don't exist yet: `ports/*` (`LlmClient`,
 * `AgentCoreClient`, `IntentRepository` — step 3-5), `app/*` use-cases
 * (step 6), `adapters/*` (mock/live LLM, `durable-ledger` HTTP client,
 * Postgres/in-memory repositories — steps 3-5), `composition-root.ts`,
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

// Use-cases

// Adapters
