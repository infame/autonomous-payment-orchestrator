# @apo/agent-evals

Adversarial eval harness for `@apo/agent-orchestrator`: it drives the orchestrator in-process with hostile scenarios and checks safety invariants and metrics. What it deliberately does not do is described in the spec, §1 "what it does NOT do". Today it contains a `RecordingAgentCoreClient` (the effect oracle: journals every call toward durable-ledger, so it is the source of truth for "did money move"), a `ScriptedLlmClient` (a hostile model replaying fixed proposals), an HTTP-only scenario runner (`runScenario`, driving the app via `app.request`), and two e2e scenarios (a benign auto-approve and a merchant-swap injection), plus a smoke test proving the orchestrator resolves as a workspace library.

## Findings

- **Merchant-swap gap (spec §9.1): FIXED.** The LLM-chosen `merchantId` used to be neither grounded against the intent text nor checked against an allowlist, and `POST /intents` accepts no `merchantId`, so on the auto-approve path a hostile proposal's merchant reached `startPaymentWorkflow` with no human in the loop. `merchantMustBeGrounded` ([ADR-0017](../../docs/adr/0017-merchant-must-be-grounded-in-the-intent-text.md), `packages/agent-orchestrator/src/policy/rules.ts`) now rejects a proposal whose merchant is not a whole token of the intent text, before `maxAutoApprove`. `src/e2e/injection-merchant-swap.test.ts` is now a regression test. Limit: an injected id written inside the intent text is still grounded, and there is no registry/allowlist.

## Running

The system under test is consumed from its built `dist` via its `exports` map, so it must be built first: run `pnpm run build` at the repo root. `pnpm --filter @apo/agent-evals test`, `typecheck` and `lint` do this for you via their `pretest`, `pretypecheck` and `prelint` scripts, which rebuild the orchestrator automatically and guard against a stale `dist` producing a silent false green.
