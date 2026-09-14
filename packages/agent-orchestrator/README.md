# @apo/agent-orchestrator

LLM intent orchestration with a deterministic policy layer, one package
(`packages/agent-orchestrator`) in the **APO** (Autonomous Payment
Orchestrator) monorepo — a portfolio project. It sits alongside
`@apo/pay-core` and `@apo/durable-ledger` in the same pnpm workspace; see
[ADR-0004](../../docs/adr/0004-monorepo-not-constellation.md) for why they're
one repository rather than a constellation of five.

This is the first package in the monorepo with an LLM inside it. `pay-core`
gives you operations that are safe to retry; `durable-ledger` builds
reliable, resumable multi-step workflows on top of that. `agent-orchestrator`
adds a **non-deterministic input** (a payment intent written in natural
language) and a **deterministic output** (a policy-validated proposal) — it
never executes anything irreversible itself. The point isn't "an agent that
can pay" — it's an agent that is **not trusted** to pay directly, and why
that's the right architecture. Full spec is kept local-only
(`docs/todo/03-agent-orchestrator.md`, not in this repo); the sections that
matter are summarised below.

## Status: steps 1-2 of 9

This package currently contains **only the domain aggregate and the
deterministic policy layer** — steps 1-2 of the spec's own implementation
order (§14):

1. **`src/domain/` (this step)** — `Intent` (the state machine) and
   `AgentProposal` (the LLM's structured output shape). No I/O.
2. **`src/policy/` (this step)** — pure guardrail functions:
   `evaluatePolicy(proposal, context) → PolicyVerdict`. No LLM, no HTTP.
3. `ports/llm-client.ts` + a directive-driven `MockLlmClient`.
4. `ports/agent-core-client.ts` + a typed HTTP client to `durable-ledger`.
5. `ports/intent-repository.ts` + Postgres (Drizzle) and in-memory adapters.
6. `app/*` use-cases wiring domain, policy, LLM port, and repository together.
7. `adapters/llm/anthropic-llm-client.ts` — the real, live LLM adapter.
8. A thin Hono HTTP layer + composition root + config + `main.ts`.
9. Tests land alongside each step above; an end-to-end demo scenario last.

None of steps 3-9 exist yet — no LLM port or adapter, no `durable-ledger`
client, no repository, no HTTP, no composition root.

## The domain model

`Intent` (`src/domain/intent.ts`) is one processed natural-language intent —
a discriminated union by `status`, same principle as `Payment` in
`@apo/pay-core`: no XState, exhaustive guarded transitions as plain methods,
no hidden mutation. See the file's header for the full transition diagram.
One transition, `received → rejected` via `declineByAgent`, extends the
spec's own literal table: an LLM can decline on its very first call, not
only after a round of clarification, and without that edge a first-pass
decline would have no legal destination.

`AgentProposal` (`src/domain/agent-proposal.ts`) is what an `LlmClient`
(step 3) is obligated to return — a discriminated union
(`propose_payment | clarify | decline`), never free text. Its
human-readable fields (`reasoning`/`question`/`reason`) are validated for
shape (non-empty, bounded length) but their *content* is never read by the
policy layer — see below.

`Intent` does not persist the user's answer to a clarification question as
its own field. That's a real, acknowledged audit-trail gap for v1: the
answer gets threaded live into `evaluatePolicy`'s `PolicyContext` once the
use-case layer exists (step 6), but nothing on `Intent` records it after
the fact. Recorded here rather than left implicit.

## Why the policy layer is separate — from both the LLM and the use-cases

`src/policy/evaluatePolicy(proposal, context) → PolicyVerdict` must be
callable and testable with **zero LLM and zero HTTP** — that's the whole
point of the package existing at all. It's the code that answers "how do
you stop the model from spending money," and it needs to be small, readable,
and not buried inside a use-case that also has to worry about persistence
and retries.

Concretely: `policy/rules.ts` deliberately never reads `AgentProposal
.reasoning` — only the structural fields (`amount`, `currency`,
`merchantId`). `amountMustBeGrounded` cross-checks the proposed `amount`
against numbers that literally appear in the intent text
(`policy/grounding.ts`), independent of whatever the LLM claims in
`reasoning`. A proposal that says "I verified this is correct" and is wrong
about the amount is rejected exactly the same as one that says nothing at
all — this is the direct defense against a prompt-injected invoice
description.

The layer is split into four files, not the spec's suggested two, to keep
the domain↔policy import graph acyclic: `Intent` stores a `PolicyVerdict`
(so `domain/intent.ts` must be able to import from `policy/`), and
`policy/rules.ts` needs `PaymentProposal` from `domain/agent-proposal.ts`.
`policy/verdict.ts` has zero imports and sits below both; `grounding.ts` is
pure text parsing with no domain dependency; `rules.ts` composes the two;
`evaluate-policy.ts` is the single exported entry point.

`PolicyVerdict`'s `reason` is a closed `PolicyReasonCode` string-literal
union with a separate `detail: string`, not a bare `string` — a stronger
reading of the spec's own requirement for an "explicit reason code."

## Why there's no `pay-core` client at all

This package only ever talks to `durable-ledger` (and only over HTTP, once
step 4 lands) — never to `pay-core` directly, and never as an imported
library. `durable-ledger` already owns the exactly-once contract with
`pay-core`; duplicating that boundary here would just be a second, weaker
copy of it.

## Why no third `Money` copy

Amounts here are only ever compared against scalar thresholds or tested for
set membership — no arithmetic. See
[ADR-0011](../../docs/adr/0011-no-third-money-copy.md) for why that means a
plain `amount: number` (integer minor units) is the right call, not a third
copy of the `Money` value object `pay-core` and `durable-ledger` each
already have one of.

## Running

```bash
pnpm install                               # from the monorepo root
pnpm --filter @apo/agent-orchestrator test # unit tests, no external services
pnpm --filter @apo/agent-orchestrator typecheck
pnpm --filter @apo/agent-orchestrator lint
```

Requires Node 24+ and pnpm.

## Considered and rejected

- **LangGraph.js.** It hides the mechanics of the agent's own reasoning
  loop behind its graph abstraction — but that mechanism, laid bare, is this
  project's stated differentiator (the deterministic policy layer wrapped
  around a non-deterministic LLM call). A framework that hides exactly the
  part meant to be visible would defeat the point of writing this package.

## Roadmap

- [x] Domain: `Intent` state machine, `AgentProposal`
- [x] Policy: pure guardrail rules + `evaluatePolicy`
- [ ] `LlmClient` port + `MockLlmClient`
- [ ] `AgentCoreClient` port + `durable-ledger` HTTP client
- [ ] `IntentRepository` port + Postgres/in-memory adapters
- [ ] `app/*` use-cases
- [ ] `AnthropicLlmClient` (live)
- [ ] Hono HTTP layer + composition root + config + `main.ts`
- [ ] End-to-end demo scenario
