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

## Status: steps 1-5 of 9, plus four of step 6's five use-cases

This package currently contains the domain aggregate, the deterministic
policy layer, the `LlmClient` port with its mock adapter, the
`AgentCoreClient` port with its `durable-ledger` HTTP client, and the
`IntentRepository` port with its Postgres and in-memory adapters — steps
1-5 of the spec's own implementation order (§14) — plus `SubmitIntent`,
`GetIntent`, `AnswerClarification`, and `RejectIntent`, four of step 6's
five `app/*` use-cases:

1. **`src/domain/`** — `Intent` (the state machine) and `AgentProposal` (the
   LLM's structured output shape). No I/O.
2. **`src/policy/`** — pure guardrail functions:
   `evaluatePolicy(proposal, context) → PolicyVerdict`. No LLM, no HTTP.
3. **`src/ports/llm-client.ts` + `src/adapters/llm/`** — the `LlmClient`
   port and a directive-driven `MockLlmClient` adapter. No real vendor call,
   no HTTP.
4. **`src/ports/agent-core-client.ts` + `src/adapters/http/durable-ledger-client.ts`**
   — the `AgentCoreClient` port and `HttpDurableLedgerClient`,
   a typed HTTP client to `durable-ledger`'s `POST /workflows/payment` and
   `GET /workflows/:eventId`. See below for what this step is and isn't.
5. **`src/ports/intent-repository.ts` + `src/adapters/persistence/drizzle/`
   + `src/adapters/memory/` (this step)** — the `IntentRepository` port,
   its own `agent` Postgres schema/migration, `PgIntentRepository`, and
   `InMemoryIntentRepository`. See "Persistence & concurrency" below.
6. `app/*` use-cases wiring domain, policy, LLM port, and repository
   together. **`SubmitIntent`, `GetIntent`, `AnswerClarification`, and
   `RejectIntent` exist** — see below. `ApproveIntent` does not yet.
7. `adapters/llm/anthropic-llm-client.ts` — the real, live LLM adapter.
8. A thin Hono HTTP layer + composition root + config + `main.ts`.
9. Tests land alongside each step above; an end-to-end demo scenario last.

Steps 7-9, and `ApproveIntent` (the rest of step 6), don't exist yet — no
HTTP layer of this package's own, no composition root, no `AgentCoreClient`
wiring into any use-case.

### `SubmitIntent` and `GetIntent` (step 6, first slice)

`SubmitIntent` (`src/app/submit-intent.ts`) creates a new `Intent` from raw
text + a customer id, asks the `LlmClient` to reason about it once, and —
when the agent proposes a payment — runs `evaluatePolicy` against it. It
performs exactly one repository write (`IntentRepository.create`) and can
leave the persisted `Intent` in exactly four statuses:
`needs_clarification`, `proposed`, `needs_approval`, or `rejected`.
`executing` is **not** reachable from this use-case — that requires a
`durableLedgerEventId`, which only a future `ApproveIntent` (calling
`AgentCoreClient`) can produce. A policy "allow" decision is surfaced to
the immediate caller (`SubmitIntentResult.verdict`) but deliberately **not**
persisted onto the intent: the daily-rate-limit rule is time-dependent, so
a stored "allow" from submission time would be stale by the time a future
use-case actually claims and executes it — policy has to be re-evaluated
then regardless. `GetIntent` (`src/app/get-intent.ts`) is a straight
`findById` → `IntentNotFoundError` on miss → read-only `IntentView`;
it does not yet scope by caller/customer (deferred to the future HTTP/auth
layer, same as `durable-ledger`'s equivalent gaps were at this stage).

Both this use-case and `AnswerClarification` (below) share their policy
wiring through `applyPolicy` (`src/app/apply-policy.ts`) — the single place
that builds `PolicyContext` (including `countCompletedSince` and
`clarificationAnswer`) and applies a `needs_approval`/`reject` verdict onto
the intent. Extracting it keeps a future caller from forgetting to wire in
`clarificationAnswer`.

### `AnswerClarification`

`AnswerClarification` (`src/app/answer-clarification.ts`) resolves a
pending clarification: it records the customer's answer onto the `Intent`
(`Intent.recordClarificationAnswer` — legal only from `needs_clarification`,
and only once), re-asks the `LlmClient` with the answer in hand, and routes
the result exactly like `SubmitIntent` does. Only **one** round of
clarification is allowed (spec §3.1): the three reachable statuses are
`proposed`, `needs_approval`, and `rejected` — never `needs_clarification`
again. If the LLM's second-round proposal is itself another `clarify`, it
is mapped to a synthetic, fixed-string decline instead of being surfaced —
the model's actual second `question` text is never echoed into that
decline reason, matching this codebase's convention that error/decline
messages never carry LLM-authored free text derived from customer input.
This use-case performs exactly one repository write
(`IntentRepository.update`), and an `IntentVersionConflictError` from that
call propagates uncaught with no retry: the only realistic trigger is two
concurrent answers to the same intent, and a retry would just re-read the
now-resolved intent and throw `InvalidIntentStateError` after wastefully
paying for a second LLM call — trading one error for another, never
succeeding. Like `RejectIntent` below, it does not yet scope by
caller/customer — anyone who knows an intent id can supply its answer;
that's deferred to the future HTTP/auth layer along with the rest of the
use-cases below.

The clarification answer **widens the grounded-amount set by design**
(spec §4): a user can ground any amount by typing it into their answer, and
that is intentional, not a guardrail bypass. `amountMustBeGrounded` is a
fabrication guard against the *model* inventing an amount out of thin air —
it has nothing to say about whether a human-supplied number is
*authorized*. `maxAutoApproveAmount`/`maxHardLimitAmount` are what actually
bound a human-supplied number, and both still run unchanged against
whatever amount the answer grounds.

### `RejectIntent`

`RejectIntent` (`src/app/reject-intent.ts`) is the single transition
`needs_approval → rejected`: an explicit human rejection of an intent
sitting at the approval gate. It takes no `LlmClient` and no
`PolicyConfig` — there is no LLM call and no policy re-evaluation, unlike
`SubmitIntent`/`AnswerClarification`. `Intent.rejectByApprover`'s own
status guard is the only wrong-status check; this use-case adds none of
its own.

There is deliberately no rejection-reason field on `RejectIntentCommand`:
spec §7's `POST /intents/:id/reject` has an empty request body, unlike
`/clarify`'s `{ answer }`. A human rejection is already uniquely
distinguishable from the other three routes into `rejected`, purely from
the persisted row:

| Route | Source status | Mechanism | Discriminator |
| --- | --- | --- | --- |
| Policy hard reject | `proposed` | `rejectByPolicy` | `policyVerdict.decision === "reject"` |
| Human rejection | `needs_approval` | `rejectByApprover` | `policyVerdict?.decision === "needs_approval"` |
| Agent declines, first pass | `received` | `declineByAgent` | `policyVerdict === null && proposal.kind === "decline" && clarificationAnswer === null` |
| Agent declines, after clarification | `needs_clarification` | `declineByAgent` | `policyVerdict === null && proposal.kind === "decline" && clarificationAnswer !== null` |

`rejectByApprover` does NOT clear `policyVerdict` — it stays exactly as
`requireApproval` set it, which is why its row is uniquely identifiable by
`decision === "needs_approval"` rather than by a null verdict. See
`domain/intent.ts`'s class header for the full rationale.

This use-case performs exactly one repository write
(`IntentRepository.update`), and — the single most important fact about
this file — an `IntentVersionConflictError` from that call propagates
uncaught, with no retry and no fallback to an unconditional write. The
conditional `update(intent, expectedVersion)` call is the entire mechanism
preventing a reject from clobbering a row that a concurrent (future)
`ApproveIntent` has already claimed into `executing`: without it, a reject
could land on top of an already-executing workflow, meaning money moved
but the persisted record claims otherwise.

**None of the four use-cases above scope by caller/customer yet** — each
takes a bare `intentId` (or, for `SubmitIntent`, a caller-supplied
`customerId` that nothing cross-checks against an authenticated identity).
For `GetIntent` that's a read-only gap; for `AnswerClarification` and
`RejectIntent` it means anyone holding an intent id can steer or terminate
someone else's pending payment. This is deliberately deferred to the
future HTTP/auth layer (step 8), same stage `durable-ledger` was at before
its own HTTP layer landed — but it must be closed there before any of
these use-cases are reachable over the network.

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

`Intent` records the user's answer to a clarification question as its own
field (`clarificationAnswer`, via `Intent.recordClarificationAnswer`) —
closing a previously-acknowledged audit-trail gap: a proposal grounded in
the user's answer is now reproducible from storage, not just threaded live
into `evaluatePolicy`'s `PolicyContext` and then forgotten.
`recordClarificationAnswer` is deliberately NOT a status transition —
`status` stays `needs_clarification` while it runs; the actual
`needs_clarification → proposed | rejected` transition still happens
separately, once `AnswerClarification` has re-asked the `LlmClient`. See
the method's own doc comment in `src/domain/intent.ts` for the full set-once
reasoning.

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

## Persistence & concurrency

`src/ports/intent-repository.ts` is the outbound persistence port for
`Intent`. `PgIntentRepository` (`src/adapters/persistence/drizzle/`) and
`InMemoryIntentRepository` (`src/adapters/memory/`) are its two
implementations; the in-memory one enforces the exact same locking
semantics as Postgres, unlike `@apo/pay-core`'s `InMemoryPaymentRepository`,
which has none.

- **Optimistic locking, not `SELECT ... FOR UPDATE`.** Every `Intent`
  mutation this package will eventually drive (LLM call → policy
  evaluation → possibly a `durable-ledger` call) can take an unpredictably
  long time — an LLM round-trip in particular. A row lock held across that
  window would pin a pooled Postgres connection for the duration, which
  under load would exhaust the pool for every other request. Optimistic
  locking (`UPDATE ... WHERE id = $1 AND version = $2`, throwing
  `IntentVersionConflictError` on zero rows) only pays a cost on a genuine
  write-write race, which is rare for a single intent. Same precedent as
  `pay-core`'s `PgPaymentRepository` — see its README's own
  "Persistence & concurrency" section.
- **`version` lives at the persistence boundary, not on `Intent`.** Unlike
  `pay-core`'s `PgPaymentRepository`, which tracks the lock version in a
  `WeakMap<Payment, number>` keyed by aggregate instance (a workaround for
  a `save(payment)` signature that predates having anywhere else to put
  it), this port was designed from scratch: `StoredIntent.version` and
  `IntentRepository.update(intent, expectedVersion)` carry it explicitly.
  That gets every implementation — Postgres AND in-memory — real locking
  for free, with no hidden per-instance state. See
  `ports/intent-repository.ts`'s header for the full rationale, including
  why the version check alone is not sufficient for durable-ledger's
  exactly-once guarantee (spec §6) — a future use-case must claim the
  intent before calling out, not after.
- **`agent` is its own Postgres schema**, not `public` (pay-core's) or
  `ledger` (durable-ledger's) — this is the third package sharing one
  Postgres instance (`docker-compose.yml`). Its own schema gives namespace
  isolation (no table-name collisions across packages when any one
  introspects the shared instance) and migration-journal isolation
  (`agent.__drizzle_migrations` is separate from the other two packages',
  so applying one package's migrations never marks another's as applied).
  See `schema.ts`'s header comment for the full rationale.
- **`clarification_answer` is a nullable `text` column** with two `CHECK`
  constraints: `intents_clarification_answer_bounded` (non-blank and
  ≤2,000 chars *when present* — a `NULL` always passes, since a SQL `CHECK`
  only fails on `FALSE`, never on `NULL`/`UNKNOWN`) and
  `intents_clarification_answer_requires_resolution` (an answer can never be
  persisted while `status` is still `received`/`needs_clarification` — the
  DB-side mirror of `AnswerClarification`'s single-write shape: record the
  answer, transition, THEN write once, never a two-write "persist the
  answer, then later persist the transition" shape). Unlike
  `durable_ledger_event_id`'s set-once trigger, there is **no** set-once
  trigger on `clarification_answer`: that trigger guards an exactly-once
  *external* side effect (a duplicate `durable-ledger` workflow run is real
  money moved twice), whereas `clarification_answer` is an audit-fidelity
  concern that's already fully prevented by the status machine (no
  transition ever re-enters `needs_clarification`) plus
  `Intent.recordClarificationAnswer`'s own "already set" guard — a second
  DB-level enforcement mechanism would be redundant, not defense-in-depth.
- **An approve and a reject are made mutually exclusive purely by the
  optimistic-lock version check**, not by any row lock. `RejectIntent`'s
  conditional `update(intent, expectedVersion)` call — the equivalent of
  `UPDATE ... WHERE id = $1 AND version = $2` — is the entire mechanism
  stopping a reject from clobbering a row a concurrent (future)
  `ApproveIntent` has already moved to `executing`. This is exactly why
  that write must never become unconditional, and why a version conflict
  on it must never be retried-and-forced through.

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

Postgres-backed integration tests (`pg-intent-repository.integration.test.ts`,
`intents-schema.integration.test.ts`) need a running Postgres and applied
migrations:

```bash
docker compose up -d postgres                        # from the monorepo root
DATABASE_URL=postgres://apo:apo@localhost:5433/apo \
  pnpm --filter @apo/agent-orchestrator db:migrate    # dev DB
pnpm --filter @apo/agent-orchestrator test:integration # applies migrations to apo_test itself via globalSetup
```

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
- [x] `IntentRepository` port + Postgres/in-memory adapters
- [x] `app/*`: `SubmitIntent`, `GetIntent`
- [x] `app/*`: `AnswerClarification`
- [x] `app/*`: `RejectIntent`
- [ ] `app/*`: `ApproveIntent`
- [ ] `AnthropicLlmClient` (live)
- [ ] Hono HTTP layer + composition root + config + `main.ts`
- [ ] End-to-end demo scenario
