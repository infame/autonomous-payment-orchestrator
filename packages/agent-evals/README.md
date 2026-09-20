# @apo/agent-evals

Adversarial eval harness for `@apo/agent-orchestrator`: it drives the orchestrator in-process with hostile scenarios and checks safety invariants and metrics. What it deliberately does not do is described in the spec, §1 "what it does NOT do". Today it contains a `RecordingAgentCoreClient` (the effect oracle: journals every call toward durable-ledger, so it is the source of truth for "did money move"), a `ScriptedLlmClient` (a hostile model replaying fixed proposals), an HTTP-only scenario runner (`runScenario`, driving the app via `app.request`), and two e2e scenarios (a benign auto-approve and a merchant-swap injection), plus a smoke test proving the orchestrator resolves as a workspace library.

## Findings

- **Merchant-swap gap (spec §9.1; security-reviewer rated HIGH).** The LLM-chosen `merchantId` is never grounded against the intent text nor checked against an allowlist, and `POST /intents` accepts no `merchantId` of its own, so a hostile proposal's merchant flows straight to `startPaymentWorkflow`. On the auto-approve path (an `Idempotency-Key` is supplied and the amount is under `maxAutoApprove`) the payment executes with no human in the loop. This is encoded by a characterization test plus an `it.fails` pair in `src/e2e/injection-merchant-swap.test.ts`. The fix is a separate agent-orchestrator PR: ground `merchantId` and/or add a per-customer allowlist as a reject/needs_approval rule evaluated before `maxAutoApprove`. When it lands, test (a) goes red on purpose and (b) flips to a plain `it`.

## Running

The system under test is consumed from its built `dist` via its `exports` map, so it must be built first: run `pnpm run build` at the repo root. `pnpm --filter @apo/agent-evals test`, `typecheck` and `lint` do this for you via their `pretest`, `pretypecheck` and `prelint` scripts, which rebuild the orchestrator automatically and guard against a stale `dist` producing a silent false green.
