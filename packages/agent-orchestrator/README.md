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

## Status: steps 1-4 of 9

This package currently contains the domain aggregate, the deterministic
policy layer, the `LlmClient` port with its mock adapter, and the
`AgentCoreClient` port with its `durable-ledger` HTTP client — steps 1-4 of
the spec's own implementation order (§14):

1. **`src/domain/`** — `Intent` (the state machine) and `AgentProposal` (the
   LLM's structured output shape). No I/O.
2. **`src/policy/`** — pure guardrail functions:
   `evaluatePolicy(proposal, context) → PolicyVerdict`. No LLM, no HTTP.
3. **`src/ports/llm-client.ts` + `src/adapters/llm/`** — the `LlmClient`
   port and a directive-driven `MockLlmClient` adapter. No real vendor call,
   no HTTP.
4. **`src/ports/agent-core-client.ts` + `src/adapters/http/durable-ledger-client.ts`
   (this step)** — the `AgentCoreClient` port and `HttpDurableLedgerClient`,
   a typed HTTP client to `durable-ledger`'s `POST /workflows/payment` and
   `GET /workflows/:eventId`. See below for what this step is and isn't.
5. `ports/intent-repository.ts` + Postgres (Drizzle) and in-memory adapters.
6. `app/*` use-cases wiring domain, policy, LLM port, and repository together.
7. `adapters/llm/anthropic-llm-client.ts` — the real, live LLM adapter.
8. A thin Hono HTTP layer + composition root + config + `main.ts`.
9. Tests land alongside each step above; an end-to-end demo scenario last.

None of steps 5-9 exist yet — no repository, no use-cases, no HTTP layer of
this package's own, no composition root.

## `AgentCoreClient` and `HttpDurableLedgerClient`

`src/ports/agent-core-client.ts` is the outbound port to `durable-ledger` —
the only system this package ever asks to actually move money (see "Why
there's no `pay-core` client at all" below). `HttpDurableLedgerClient`
(`src/adapters/http/durable-ledger-client.ts`) is its only implementation so
far, structurally mirroring `durable-ledger`'s own `HttpPayCoreClient`
(global `fetch`, `AbortSignal.timeout` combined with a caller signal via
`AbortSignal.any`, one private `request<T>()` helper, zod-validated
responses, a pure `agentCoreErrorFor` classifier). Its test double,
`src/adapters/http/fake-durable-ledger-server.ts`, is a real `node:http`
server transcribed from `durable-ledger`'s actual routes — test support
only, not exported — for the same reasons ADR-0006 gives for pay-core's
equivalent fake.

Four things worth knowing about the shape of this port:

- **The `paymentMethodToken` is a caller-supplied argument, never something
  the LLM proposes.** `PaymentProposal` has no such field; `paymentWorkflow
  RequestFor` takes it as a sibling parameter, sourced from configuration in
  a later step. It doubles as the wire carrier for `pay-core`'s
  `SimulatorProvider` directive grammar (`sim.ok`, `sim.decline.<code>`,
  `sim.fail_then_succeed.<n>`, `sim.timeout`), which is the only way this
  project's headline demo scenario — a simulated 503 followed by a durable
  retry — stays reachable. See
  [ADR-0012](../../docs/adr/0012-payment-method-token-is-supplied-not-proposed.md).
- **`Intent.customerId` has no destination on the wire.** durable-ledger's
  `paymentExecuteRequestedSchema` has no `customerId` field, and
  `PostingGroup.forCapture` only ever posts between `acquirer_clearing` and
  `merchant:<id>` — there is no customer-side ledger account for it to
  reach. `customerId` stays a local field on this package's side of the
  boundary.
- **The client is stateless: no de-duplication, no polling.** It performs no
  caching of its own — `Intent.autoApprove`/`Intent.approve`
  (`domain/intent.ts`) already require a `durableLedgerEventId` before
  allowing the transition to `executing`, and that is where this project's
  exactly-once guarantee against durable-ledger's un-idempotent
  `POST /workflows/payment` actually lives. There is also no blocking
  `waitForCompletion` method: `getRunStatus` is a single HTTP call, matching
  spec §7's requirement that `POST /intents` must not block until a workflow
  finishes.
- **A bare 404 is not the same as "run not found."** `agentCoreErrorFor`
  deliberately diverges from durable-ledger's own `payCoreErrorFor` (which
  maps every 404 to "not found"): only a 404 on `GET /workflows/:eventId`
  carrying `workflow_run_not_found` becomes `AgentCoreRunNotFoundError`. A
  bare `not_found`, or any 404 on `POST /workflows/payment` (a route that
  can never legitimately 404), becomes `AgentCoreUnexpectedResponseError`
  instead — collapsing those into "run not found" would disguise a
  base-URL misconfiguration as a domain outcome.

Not built in this step, by design (decision C of the plan this step came
from): a `FakeAgentCoreClient` in-process port double. This step's own tests
are covered by the HTTP fake server; an in-process double is a future
use-case step's job, once there's a use-case to test against it.

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

## `LlmClient` and `MockLlmClient`

`src/ports/llm-client.ts` is the outbound port to whatever turns intent text
into an `AgentProposal` — a real vendor model (step 7) or `MockLlmClient`
(`src/adapters/llm/mock-llm-client.ts`, this step). `reason()` either
resolves with an already-domain-valid `AgentProposal` (built through
`paymentProposal`/`clarifyProposal`/`declineProposal`, never a raw object
literal) or rejects with an `LlmClientError` subclass — see the port file's
header for the full contract, including why `clarificationAnswer` is
`string | null` rather than the spec's `?: string` sketch.

`MockLlmClient` is steered by a small directive grammar
(`src/adapters/llm/directives.ts`) scanned out of `intentText`/
`clarificationAnswer`:

| Directive | Effect |
|---|---|
| `sim.unavailable` | Rejects with `LlmUnavailableError` |
| `sim.decline` / `sim.decline.<slug>` | Declines; default slug `unsupported_request` |
| `sim.clarify` / `sim.clarify.<slug>` | Asks for clarification (first pass only); default slug `amount` |
| `sim.amount.min` | Proposes the minimum amount found in the text |
| `sim.amount.max` | Proposes the maximum amount found in the text |
| `sim.amount.ungrounded` | Proposes an amount NOT found in the text (the adversarial case) |
| `sim.currency.<CODE>` | Sets the proposed currency (`[A-Z]{3}`, else ignored) |
| `sim.merchant.<id>` | Sets the proposed merchant id (`[A-Za-z0-9_-]{1,64}`, else ignored) |

The grammar is deliberately **digit-free**: `sim.amount.*` never encodes a
literal amount, it only *selects* among amounts `policy/grounding.ts`'s
`extractGroundedAmounts` already finds in the real text. Unlike `pay-core`'s
`SimulatorProvider`, whose directives ride inside an opaque carrier string
nothing else reads as data, `intentText` here is genuinely parsed by the
policy layer's own grounding rule — a directive that could smuggle in an
arbitrary amount would let the mock produce proposals the guardrail this
package exists to exercise would never actually allow through. Undirected
text falls back to proposing the minimum candidate amount (spec §3.3's
safe-interpretation rule) when one exists, or declining when it doesn't.

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
- [x] `LlmClient` port + `MockLlmClient`
- [x] `AgentCoreClient` port + `durable-ledger` HTTP client
- [ ] `IntentRepository` port + Postgres/in-memory adapters
- [ ] `app/*` use-cases
- [ ] `AnthropicLlmClient` (live)
- [ ] Hono HTTP layer + composition root + config + `main.ts`
- [ ] End-to-end demo scenario
