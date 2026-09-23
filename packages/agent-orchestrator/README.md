# @apo/agent-orchestrator

[![CI](https://github.com/infame/autonomous-payment-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/infame/autonomous-payment-orchestrator/actions/workflows/ci.yml)

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

## Status: step 9 of 9 — complete

Also consumed as a library via its `exports` map by `@apo/agent-evals` (see [ADR-0016](../../docs/adr/0016-agent-evals-imports-the-built-orchestrator.md)).

This package currently contains the domain aggregate, the deterministic
policy layer, the `LlmClient` port with its mock adapter, the
`AgentCoreClient` port with its `durable-ledger` HTTP client, and the
`IntentRepository` port with its Postgres and in-memory adapters — steps
1-5 of the spec's own implementation order (§14) — plus all five of step
6's `app/*` use-cases: `SubmitIntent`, `GetIntent`, `AnswerClarification`,
`RejectIntent`, and `ApproveIntent` — plus step 7, `AnthropicLlmClient`,
the live `LlmClient` adapter — plus all four of step 8's slices: a sixth
`app/*` use-case, `SyncIntentExecution`; `config.ts`; the Hono HTTP layer
(see "HTTP interface" below); and the composition root + `main.ts` (see
"Running the service" below) that actually construct real adapters and
boot the service:

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
   `GET /workflows/:eventId`. Every request sends the configured
   `DURABLE_LEDGER_SERVICE_SECRET` as `X-Service-Secret`. See below for what
   this step is and isn't.
5. **`src/ports/intent-repository.ts` + `src/adapters/persistence/drizzle/`
   + `src/adapters/memory/` (this step)** — the `IntentRepository` port,
   its own `agent` Postgres schema/migration, `PgIntentRepository`, and
   `InMemoryIntentRepository`. See "Persistence & concurrency" below.
6. `app/*` use-cases wiring domain, policy, LLM port, and repository
   together. **All five exist: `SubmitIntent`, `GetIntent`,
   `AnswerClarification`, `RejectIntent`, and `ApproveIntent`** — see below.
7. **`adapters/llm/anthropic-llm-client.ts` — the real, live LLM adapter.**
   Done: see "`LlmClient`, `MockLlmClient`, and `AnthropicLlmClient`" below.
8. A thin Hono HTTP layer + composition root + config + `main.ts`, plus the
   `app/*` use-cases the HTTP layer needs that don't fit under step 6's
   original five — `SyncIntentExecution` (below), the `executing → terminal`
   reconciliation use-case `GET /intents/:id` now calls. `config.ts`
   (env-var parsing) is done, the Hono HTTP layer (`adapters/http/`, see
   "HTTP interface" below) wires all seven use-cases behind real routes, and
   the composition root (`composition-root.ts`) + `main.ts` (see "Running
   the service" below) construct real adapters and boot the service. Step 8
   is done.
9. Tests land alongside each step above. This step's own deliverable —
   a `Dockerfile`, `docker-compose.yml` wiring, and CI (this step) — is
   now done; see "Docker" under "Running the service" below and
   `.github/workflows/ci.yml`. An end-to-end demo scenario is still to
   come.

All four of step 8's slices — `SyncIntentExecution`, `config.ts`, the Hono
HTTP layer, and the composition root + `main.ts` — are done.
`AgentCoreClient` is wired into two use-cases (`ApproveIntent` and
`SyncIntentExecution`, both below), and both are reachable over HTTP
(`POST /intents/:id/approve`, `GET /intents/:id`) against real adapters
`createAgentOrchestrator` constructs. **`AnthropicLlmClient` is now wired
end-to-end**: `composition-root.ts`'s `createLlmClient` builds it whenever
`config.ts`'s `LLM_MODE` switch (`mock` | `live`) resolves to `live`, and
`loadConfig` validates that `live` mode carries an `ANTHROPIC_API_KEY` at
boot. See "Running the service" below for how to actually reach `live`
mode.

### `SubmitIntent` and `GetIntent` (step 6, first slice)

`SubmitIntent` (`src/app/submit-intent.ts`) creates a new `Intent` from raw
text + a customer id, asks the `LlmClient` to reason about it once, and —
when the agent proposes a payment — runs `evaluatePolicy` against it. It
performs exactly one repository write (`IntentRepository.create`) and can
leave the persisted `Intent` in exactly four statuses:
`needs_clarification`, `proposed`, `needs_approval`, or `rejected`.
`executing` is **not** reachable from this use-case — that requires a
`durableLedgerEventId`, which only `ApproveIntent` (calling
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

The same holds for the payee: the answer also widens the grounded-*merchant*
set, so a user can name a payee by typing it into their answer. That is by
design — `merchantMustBeGrounded` guards against the *model* fabricating a
payee, not against a human choosing one.

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

### `ApproveIntent`

`ApproveIntent` (`src/app/approve-intent.ts`) is the single transition
`needs_approval → executing`: it triggers a real durable-ledger payment
workflow via `AgentCoreClient.startPaymentWorkflow`. It is the only
use-case in this package that ever calls that port — the operation that
actually moves money.

**The exactly-once guarantee, precisely stated:** at most one durable-ledger
workflow run is ever created per intent, ALWAYS — even under crashes,
retries, or concurrent calls — **within Inngest's own event-retention
window**. That qualifier is not this README hedging; it's ADR-0013's own
Consequences section, verbatim: the guarantee is "bounded... not an
absolute one," and the window itself "was not measured against Inngest
Cloud," only against a local dev server. This holds because `ApproveIntent`
supplies `intent.id` as durable-ledger's `Idempotency-Key`
(`StartPaymentWorkflowOptions.idempotencyKey`, ADR-0013 in
`@apo/durable-ledger`), and because a
short-circuit on `intent.status === "executing"` (checked BEFORE any client
call) makes a re-invocation on an already-triggered intent send no request
at all. What is NOT guaranteed in every case is a CORRECT *handle* to that
run: if this process crashes in the narrow window between durable-ledger
accepting the trigger and this use-case's own confirming write landing, a
later retry sends the same idempotency key again, gets back a different
(permanently un-runnable, forever-`queued`) `eventId`, and THAT is the one
that ends up persisted — the real run still happened, exactly once, but the
stored `durableLedgerEventId` now points at a dud instead of it. This is
**accepted, not fixed here**: no `workflow_runs` correlation table, no
polling-harder logic. Money safety was the actual requirement; a
correlation table to guarantee handle correctness too was explicitly
declined in durable-ledger's own ADR-0010/ADR-0013 as disproportionate to
the problem it would solve. A stuck `queued` status on an `executing`
intent is the visible symptom, and the trigger for manual reconciliation,
not a bug to chase.

A version conflict on the confirming write is never allowed to silently
drop the eventId this use-case just triggered: it's caught and rethrown as
`ExecutionRaceLostError`, carrying that eventId forward, rather than a bare
`IntentVersionConflictError` a caller might reasonably retry (retrying
would just re-discover the intent already moved on, having thrown away the
one piece of information that made the case worth distinguishing).

**No caller/customer scoping — worded as forcefully as it needs to be.**
`ApproveIntentCommand` carries no caller identity: anyone who knows an
intent id can call this use-case and trigger a REAL payment against
someone else's intent. This is not a hypothetical gap; it is the single
most important thing to close, at the future HTTP/auth layer (step 8),
before this use-case is ever wired up as `POST /intents/:id/approve`.

### `SyncIntentExecution` (step 8, first slice)

`SyncIntentExecution` (`src/app/sync-intent-execution.ts`) reconciles an
`executing` intent against durable-ledger's actual workflow status via
`AgentCoreClient.getRunStatus` — closing the gap left after `ApproveIntent`
where `Intent.complete`/`Intent.fail`/`Intent.flagForReview` and
`getRunStatus` otherwise had no caller at all, so an intent that reached
`executing` would stay there forever. It is a separate use-case from
`GetIntent` rather than an optional dependency on it — an optional
`agentCore` constructor argument would let a caller silently turn a pure
query into a mutating call. On an `executing` intent it performs at most
one repository write, only on an actual transition
(`completed`/`failed`/`needs_review`); a non-`executing` intent, a
non-terminal (`queued`/`running`) snapshot, or an `AgentCoreClientError`
from `getRunStatus` all return the stored view unchanged with no write.
Unlike `ApproveIntent`, an `AgentCoreClientError` here is swallowed rather
than propagated: this is the *read* path a polling client will hammer
repeatedly, and a stale `executing` is a strictly better answer than a 503
on every poll — the opposite tradeoff from `ApproveIntent`, where the
failing call was the one that was supposed to move money. It is the
use-case `GET /intents/:id` calls (see "HTTP interface" below).

**Six of the seven use-cases above don't scope by caller/customer
THEMSELVES** — each still takes a bare `intentId` (or, for `SubmitIntent`, a
caller-supplied `customerId` that nothing inside the use-case cross-checks
against anything). For `GetIntent` and `SyncIntentExecution` that's a
read-only gap; for `AnswerClarification`, `RejectIntent`, and — most
importantly — `ApproveIntent`, it would mean anyone holding an intent id
could steer, terminate, or trigger real money movement on someone else's
pending payment — if these use-cases were ever called directly, bypassing
the HTTP layer. That gap is closed one level up, at the HTTP boundary: every
id-addressed route in "HTTP interface" below compares `X-Customer-Id`
against the stored `Intent.customerId` before calling any of these SIX
use-cases, per [ADR-0014](../../docs/adr/0014-customer-scoping-without-authentication.md).
Those six use-cases remain individually unsafe on their own — ADR-0014
states this as a binding constraint on any FUTURE driving adapter for this
package, not just a description of this one.

**`AutoApproveIntent` is the seventh, and the one deliberate exception**: it
does NOT go through that same HTTP-layer ownership comparison. Instead,
`AutoApproveIntentCommand` itself carries `customerId`, and `execute()`
compares it against the stored `Intent.customerId` directly (same
404-not-403 shape as ADR-0014) — see "HTTP interface" below (the
`AutoApproveIntent` paragraph) for why that check is defense in depth rather
than load-bearing at its one call site, and
[ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md)
for the full derivation-scoping argument underneath it.

## HTTP interface

`adapters/http/app.ts`'s `createAgentOrchestratorApp(deps)` builds a Hono
`app` wired against the seven use-cases above (`AgentOrchestratorAppDeps`
now carries seven; `autoApproveIntent` has no route of its own — see below).
It takes its deps as a plain parameter object (`AgentOrchestratorAppDeps`,
each use-case narrowed to `Pick<X, "execute">`) and constructs nothing
itself — no real `IntentRepository`, `LlmClient`, or `AgentCoreClient`
adapter is ever constructed inside `adapters/http/`. Building and injecting
real adapters is `composition-root.ts`'s job — see "Running the service"
below.

| Route | Use-case | Success | Notes |
| --- | --- | --- | --- |
| `POST /intents` | `SubmitIntent`, then — only with a valid `Idempotency-Key` header AND a resulting `proposed` status — `AutoApproveIntent` | `201 { intent, verdict }` | `customerId` comes from `X-Customer-Id`, never the body. Optional `Idempotency-Key` header (ADR-0015): derives a deterministic `Intent.id`, enables retry-safe replay, and is the sole trigger for auto-approve. Likewise comes from the header only — a body-level `idempotencyKey` field is stripped and ignored. Status stays `201` even on a replay or an auto-approve chain — never a separate status code |
| `POST /intents/:id/clarify` | `AnswerClarification` | `200 { intent, verdict }` | |
| `POST /intents/:id/approve` | `ApproveIntent` | `200 { intent }` | no `verdict` key at all |
| `POST /intents/:id/reject` | `RejectIntent` | `200 { intent }` | no `verdict` key at all |
| `GET /intents/:id` | `SyncIntentExecution` (falls back to `GetIntent` on a version conflict) | `200 { intent }` | no `verdict` key at all |
| `GET /healthz` | none | `200 { status: "ok" }` | liveness only, see below |

`AutoApproveIntent` is deliberately not addressable as its own route: it is
called from exactly one place, `POST /intents`, immediately after a keyed
`SubmitIntent` call lands on `proposed`. Unlike the four id-addressed routes
above, `app.ts` itself performs no separate ownership pre-check before this
call — `AutoApproveIntent.execute()` takes `customerId` on its own command
and performs that comparison itself (throwing the same `IntentNotFoundError`
a mismatch anywhere else would throw), as defense in depth rather than
because the call site needs it: the `intentId` passed in here is always
already scoped to the SAME caller's own `customerId`, either freshly minted
for this request or derived via `deriveIntentId(customerId, idempotencyKey)`
from it — see `AgentOrchestratorAppDeps`'s own doc comment in `app.ts` and
[ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md)
for the full derivation-scoping argument.

The `{ intent, verdict }` vs. `intent.policyVerdict` distinction from
`SubmitIntent`/`AnswerClarification`'s own headers carries through
unchanged at the HTTP layer: `verdict` is the ephemeral, just-computed
`PolicyVerdict` (including `allow`, which is never persisted), while
`intent.policyVerdict` is whatever `needs_approval`/`reject` verdict is
actually stored on the row (`null` on an `allow` or a `clarify`/`decline`
outcome). `approve`/`reject`/`GET` never carry a `verdict` key at all —
not `verdict: null` — because no policy evaluation happens on those routes;
its absence is the signal.

### Customer scoping

`X-Customer-Id` is the sole caller-identity channel — see
[ADR-0014](../../docs/adr/0014-customer-scoping-without-authentication.md)
for the full argument. In short: it's a bare, unsigned, trivially-spoofable
header, not real authentication (acceptable for this portfolio project's
stated scope). Every id-addressed route reads it, reads `:id`, calls
`GetIntent.execute(id)`, and — on a mismatch against the stored
`Intent.customerId` — throws the exact same `IntentNotFoundError` a genuine
miss would throw, BEFORE calling the route's real use-case. A mismatch is
always `404`, never `403`: a `403` would be an existence oracle, and
combined with `InvalidIntentStateError`'s status-bearing message, a state
oracle too. This ownership check running strictly before the use-case call
is the entire security property of this HTTP layer — see `app.ts`'s own
header for why getting that ordering wrong is the single most dangerous
possible change to that file.

### Error mapping

`adapters/http/server-error-mapper.ts`'s `mapError` is the single place
every thrown error becomes a status + JSON envelope
(`{ error: { code, message, details?, durableLedgerEventId? } }`):

| Error | Status | Code |
| --- | --- | --- |
| `ZodError` | 400 | `validation_failed` |
| `HttpError` (bad header/JSON, this file's own throws) | its own | its own |
| `ExecutionRaceLostError` | 409 | `execution_race_lost` (+ `durableLedgerEventId`) |
| `IdempotencyConflictError` | 409 | `idempotency_conflict` |
| `IntentNotFoundError` | 404 | `intent_not_found` |
| `InvalidIntentStateError` | 422 | `invalid_intent_state` |
| `InvalidIntentError` | 400 | `invalid_intent` |
| `IntentVersionConflictError` | 409 | `intent_version_conflict` |
| `InvalidProposalError`, `IntentAlreadyExistsError`, `IntentDerivationCollisionError` | 500 | `internal_error` (server faults, never a caller-fixable 4xx) |
| `LlmUnavailableError` | 503 | `llm_unavailable` |
| `LlmConfigurationError` | 500 | `llm_configuration_error` |
| `LlmProtocolError` | 502 | `llm_protocol_error` |
| `AgentCoreUnavailableError` | 503 | `agent_core_unavailable` |
| `AgentCoreNetworkError` | 503 | `agent_core_network_error` |
| `AgentCoreTimeoutError` | 504 | `agent_core_timeout` |
| `AgentCoreUnexpectedResponseError` | 503 if `.retryable`, else 502 | `agent_core_unexpected_response` |
| `AgentCoreMalformedResponseError` | 502 | `agent_core_malformed_response` |
| `AgentCoreBadRequestError`, `AgentCoreRunNotFoundError`, `AgentCoreRequestCanceledError` | 500 | `internal_error` (this client's own fault, never the caller's) |
| anything else | 500 | `internal_error` |

A policy `reject` is explicitly **not** an error — `POST /intents` on a
hard-rejected proposal is a `201` with `intent.status === "rejected"`, not a
4xx; see "HTTP interface" above. `idempotency_conflict` (409) fires when a
retried `POST /intents` reuses an `Idempotency-Key` with different `text`
than the original call — see [ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md).
A *malformed* `Idempotency-Key` (blank, whitespace-only, or otherwise
failing shape validation) is instead a `400 invalid_idempotency_key`,
through the generic `HttpError` row above — never silently treated as "no
key supplied". Every `LlmClientError`/`AgentCoreClientError`
row uses a FIXED message, never `err.message`/`err.reason` — both ports'
own headers already forbid building an error message from vendor/response
detail, and this mapper is the last line of defense against that leaking
onto the wire. `execution_race_lost` is the one deliberate exception to the
shared `{code, message, details?}` envelope: it also carries
`durableLedgerEventId`, the sole handle to an orphaned, money-moving
durable-ledger run (no `workflow_runs` correlation table exists to
re-derive it, per ADR-0010/0013). Several rows are currently unreachable in
practice — `AgentCoreBadRequestError`/`AgentCoreRunNotFoundError`/
`AgentCoreRequestCanceledError` can only originate from this client's own
bug or an explicit caller cancellation, `InvalidProposalError`/
`IntentAlreadyExistsError` require `LlmClient`/`IntentRepository` to violate
their own documented contracts, and `IntentDerivationCollisionError` (see
[ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md))
needs an actual SHA-1 collision on the derived intent id — they're mapped
anyway so the mapper fails closed rather than falling through to a
misleading default.

### Why `/healthz` is liveness-only

Same rationale as both sibling packages: pinging the LLM or the database on
every load-balancer probe interval would be wasteful at best (extra vendor
calls/DB round-trips on a timer that has nothing to do with real traffic)
and dangerous at worst (a probe interval tighter than a real outage's
recovery time could flap the process in and out of rotation). `GET /healthz`
touches none of the seven deps — see `app.test.ts`'s own test proving this by
building an app whose every dep is a throwing stub and confirming `/healthz`
still returns `200`.

### Deviations from spec §7

- Spec §7's `merchantId?` field is dropped from `POST /intents`'s body, not
  merely omitted-for-now: `SubmitIntentCommand` has no such field, and
  `PaymentProposal.merchantId` always comes from the LLM's own proposal (or
  `MockLlmClient`'s configured default), never from the caller.
- The response envelopes are a superset of spec §7's sketched
  `{intentId, status, proposal?}` — see "HTTP interface" above for the
  actual shapes (`{intent, verdict}` or `{intent}`, `intent` itself a full
  `IntentView`).
- `X-Customer-Id` is an addition spec §7 doesn't mention at all — see
  ADR-0014 for why it exists.

`POST /intents`'s optional `Idempotency-Key` header and its `AutoApproveIntent`
chaining are new additions spec §7 doesn't mention either — see "The domain
model" below (the section that used to describe `Intent.autoApprove` having
no production caller) and [ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md)
for the full mechanism, not restated here.

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
- **The client caches nothing itself, but the wire call is no longer
  un-idempotent.** Since durable-ledger's ADR-0013, `POST /workflows/payment`
  accepts an optional `Idempotency-Key` header
  (`StartPaymentWorkflowOptions.idempotencyKey`): a caller-supplied key makes
  Inngest create at most one workflow run no matter how many times the same
  key is sent. `ApproveIntent` (below) supplies `intent.id` as that key.
  `Intent.autoApprove`/`Intent.approve` (`domain/intent.ts`) requiring a
  `durableLedgerEventId` before allowing the transition to `executing` is a
  SECOND, independent layer — it guards against two concurrent use-case
  calls both passing the same `Intent`'s own guard, which the durable-ledger
  key alone has no way to know about. There is also no blocking
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

`src/adapters/memory/fake-agent-core-client.ts` — built once `ApproveIntent`
actually needed an `AgentCoreClient` double to test against, and since
extended for `SyncIntentExecution`'s tests (above) — is an in-process port
double, distinct from the HTTP fake server above: that fake exercises
`HttpDurableLedgerClient`'s own request/response/error-classification
wiring over a real socket, while this one lets an `app/*` use-case test
assert on calls directly with no HTTP involved at all. It is deliberately
NOT a trivial stub: it mints a fresh `eventId` on every `startPaymentWorkflow`
call, but only creates a genuine new run the first time a given
`idempotencyKey` is seen — modeling ADR-0013's empirically-verified Inngest
dedup behavior, including the "dud handle" case (a later call with an
already-seen key gets back a real-looking but permanently un-runnable
`eventId`). `settleRun`/`getRunStatusError` let a test progress a
registered run past its initial `queued` snapshot, or force a specific
`AgentCoreClientError` out of `getRunStatus` — needed once
`SyncIntentExecution` gave this fake its first caller of `getRunStatus`
that cares about anything beyond "not found". Test support only, not
exported — same reasoning as the HTTP fake server above.

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

**Auto-approve: a policy `allow` verdict's route out of `proposed`.**
`Intent.autoApprove` (the domain's own `proposed → executing` transition,
for exactly this case) now has a production caller: `AutoApproveIntent`
(`src/app/auto-approve-intent.ts`), triggered from inside the `POST
/intents` handler immediately after a `SubmitIntent` call, but **only** when
the caller supplied an `Idempotency-Key` header AND the resulting intent
landed on `proposed` (which, per `SubmitIntent`'s own invariant, uniquely
means the fresh policy pass just returned `allow`). When present, that key
makes `SubmitIntent` derive `Intent.id` *deterministically* —
`deriveIntentId(customerId, idempotencyKey)`, a UUIDv5 over
`${customerId}:${idempotencyKey}` (`app/derive-intent-id.ts`) — instead of
generating a random one, which is what makes it safe to chain a real
durable-ledger trigger onto the very first `POST /intents` call: a retried
submission re-derives the *same* `Intent.id`, which both naturally dedups
against `SubmitIntent`'s own `IntentAlreadyExistsError` path and, because
`AutoApproveIntent` supplies that same id as durable-ledger's
`Idempotency-Key` (ADR-0013), reuses the same trigger-level dedup key too —
never a second real payment for the same retried request. See
[ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md)
for the full design (why a deterministic id and not a separate key column,
why the header is optional, why a same-key/different-text retry is a `409
idempotency_conflict` instead of a silent replay, and the inherited
ADR-0013 "dud handle" residual risk).

**The permanent caveat, stated as bluntly as the limitation used to be
stated: a `POST /intents` call WITHOUT an `Idempotency-Key` header still
cannot auto-approve.** A policy-`allow` intent submitted without a key
still parks at `proposed` forever, exactly as before this feature — this is
not a gap left over to close in some future slice, it is the mechanism's
load-bearing safety property. There is no dedup key to hand durable-ledger
without one, and no safe way to retry a real-money trigger without a dedup
key. A client must explicitly opt in by supplying `Idempotency-Key` for
auto-approve to ever fire; `needs_approval → executing` via `ApproveIntent`
remains the only route to `executing` for everything else.

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

`merchantMustBeGrounded` applies the same idea to the payee: the proposed
`merchantId` must be a whole, case-folded token of the intent text (or
clarification answer), else the proposal is rejected with
`merchant_not_grounded` before `maxAutoApprove` can auto-approve it. It closes
the swapped-payee path on auto-approve; it does not prove the payee is
*legitimate* — a hostile id written inside the intent text is still grounded,
and there is no allowlist/registry (see ADR-0017).

| Rule | Condition | Verdict |
|---|---|---|
| `currencyAllowed` | currency not in `allowedCurrencies` | reject `currency_not_allowed` |
| `amountMustBeGrounded` | amount not a literal number in the text | reject `amount_not_grounded` |
| `merchantMustBeGrounded` | merchantId not a whole token of the text | reject `merchant_not_grounded` |
| `maxHardLimit` | amount > `maxHardLimitAmount` | reject `hard_limit_exceeded` |
| `dailyRateLimit` | completed intents in 24h >= `dailyRateLimit` | reject `daily_rate_limit_exceeded` |
| `maxAutoApprove` | amount >= `maxAutoApproveAmount` | needs_approval `above_auto_approve_threshold` |

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

## `LlmClient`, `MockLlmClient`, and `AnthropicLlmClient`

`src/ports/llm-client.ts` is the outbound port to whatever turns intent text
into an `AgentProposal` — the deterministic `MockLlmClient`
(`src/adapters/llm/mock-llm-client.ts`) or the real vendor model,
`AnthropicLlmClient` (`src/adapters/llm/anthropic-llm-client.ts`, step 7).
`reason()` either resolves with an already-domain-valid `AgentProposal`
(built through `paymentProposal`/`clarifyProposal`/`declineProposal`, never
a raw object literal) or rejects with an `LlmClientError` subclass — see the
port file's header for the full contract, including why `clarificationAnswer`
is `string | null` rather than the spec's `?: string` sketch.

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

The mock's default merchant is `vendor` (a word present in every demo text), so it passes `merchantMustBeGrounded`. `sim.merchant.<id>` is self-grounding (the directive itself is part of the text), so the mock cannot demonstrate a `merchant_not_grounded` reject; use `new MockLlmClient({ defaultMerchantId: "..." })` for that.

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

### `AnthropicLlmClient` (live, step 7)

`AnthropicLlmClient` (`src/adapters/llm/anthropic-llm-client.ts`) is the real
`LlmClient` — everywhere `MockLlmClient` stands in during development,
tests, and the demo's `mock` mode, `live` mode would use this instead once
step 8 wires it up. It talks to `@anthropic-ai/sdk`'s Messages API, but
never directly to `fetch`: `AnthropicLlmClientOptions.messages` is a narrow
`AnthropicMessagesApi` interface (one `create` method) that the real SDK's
`client.messages` satisfies structurally — the same "inject only the
interface you need" shape `AgentCoreClient` uses for `durable-ledger`.

**Three tool calls, one decision.** Rather than parsing free-form prose out
of a text response, `reason()` forces the model to always answer via
exactly one of three tool calls — `propose_payment`, `ask_clarifying_question`,
`decline` (`src/adapters/llm/anthropic-tools.ts`) — via
`tool_choice: {type: "any", disable_parallel_tool_use: true}`. These are
response *channels* for the one `AgentProposal` union `reason()` has always
had to return, not three new capabilities: every way the model could
otherwise fail to produce a valid proposal — a missing field, a wrong type,
two simultaneous tool calls, an unrecognized tool name, a `stop_reason`
that isn't `tool_use` at all — becomes a typed, caught error instead of a
silent misparse. `ask_clarifying_question` is structurally omitted from the
tool list once a clarification answer is already in hand
(`toolsFor(clarificationAnswer)`), enforcing the one-clarification-round
rule even against a model that ignores its own instructions.

**Minor units, grounding, and the steer-vs-enforce boundary.**
`src/adapters/llm/anthropic-prompt.ts`'s system prompt spends real effort
telling the model that `amount` is an integer in minor units (cents — "$100
is 10000, not 100") and that a proposed amount must appear literally in the
source text or be the *smallest* candidate when ambiguous, never the
largest or a sum. Its MERCHANT GROUNDING RULE likewise only steers the
payee. None of that is enforcement: `reason()` itself never
re-derives or filters on grounding. That guarantee lives entirely in
`evaluatePolicy`'s `amountMustBeGrounded` and `merchantMustBeGrounded`
([ADR-0017](../../docs/adr/0017-merchant-must-be-grounded-in-the-intent-text.md))
rules (both in `policy/rules.ts`), applied
uniformly to every `AgentProposal` regardless of which `LlmClient` produced
it — a domain-valid but policy-hostile proposal from `AnthropicLlmClient` is
expected to flow through completely untouched, both for the audit trail and
for policy-testing parity with `MockLlmClient`.

**Error mapping** (`src/adapters/llm/anthropic-errors.ts`) maps the SDK's
error hierarchy onto this port's closed rejection set, using only
`status`/the vendor's `type` discriminator/`requestID` — never the vendor's
own `message`/response body, which can echo request content (including the
customer's intent text):

| Error | Triggers on |
|---|---|
| `LlmUnavailableError` (retryable) | timeout, connection failure, aborted request, or an API status that's `undefined`/`>=500`/`408`/`429` |
| `LlmConfigurationError` (not retryable) | any other API error status (400/401/403/404/409/422 — bad credentials, bad model id, malformed tool schema) or a non-`APIError` SDK failure before a request was even sent |
| `LlmProtocolError` (not retryable) | a response that isn't a single valid tool call — wrong `stop_reason`, zero/multiple `tool_use` blocks, an unrecognized tool name, a schema-invalid `input`, or a domain-valid-shape rejection from `paymentProposal`/`clarifyProposal`/`declineProposal` itself |

**The API key never reaches `AnthropicLlmClient`.** `createAnthropicClient`
(`src/adapters/llm/anthropic-client.ts`) is the only place a real API key is
handled; it also closes a real footgun in the SDK's own constructor — an
`apiKey` of `undefined` silently falls back to `process.env.ANTHROPIC_API_KEY`
or a config-file/profile chain, so an under-configured deployment can end up
authenticating as whatever credential happens to be on the host — an
explicit blank string does *not* trigger that fallback (it just 401s later,
more slowly and more confusingly). `createAnthropicClient` requires a
non-blank `apiKey` up front and throws `LlmConfigurationError` immediately
otherwise. Only the narrow `AnthropicMessagesApi` surface (never the full
client, never the key itself) is what actually gets injected into
`AnthropicLlmClient`.

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
  why a "claim before calling durable-ledger" write is structurally
  impossible on this port (the domain and a DB `CHECK` constraint both
  require a real `durableLedgerEventId` only durable-ledger can mint) and
  why the version check's role is narrower than that: it makes an approve
  and a reject on the same `Intent` mutually exclusive, not exactly-once
  against durable-ledger itself — see `ApproveIntent` below for that half.
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
  stopping a reject from clobbering a row `ApproveIntent` has already moved
  to `executing`, and vice versa. This is one of two layers, not the only
  one: it is what makes approve/reject mutually exclusive on THIS side of
  the boundary, but exactly-once protection against a duplicate
  durable-ledger trigger (a retried call, a crash-and-retry) is a second,
  independent layer living at the durable-ledger boundary itself
  (`Idempotency-Key`, ADR-0013) — see `ApproveIntent` below for the full
  accounting. This is exactly why the conditional write must never become
  unconditional, and why a version conflict on it must never be
  retried-and-forced through.

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

## Running the service

```bash
docker compose up -d postgres                 # from the monorepo root; postgres:17-alpine on :5433
# in another terminal, or already running: durable-ledger itself (see its own README)

export DURABLE_LEDGER_SERVICE_SECRET="<same 32+-character value used by durable-ledger>"
DATABASE_URL=postgres://apo:apo@localhost:5433/apo \
DURABLE_LEDGER_URL=http://localhost:3100 \
DURABLE_LEDGER_SERVICE_SECRET="$DURABLE_LEDGER_SERVICE_SECRET" \
PAYMENT_METHOD_TOKEN=pm_demo_token \
pnpm --filter @apo/agent-orchestrator start   # after `pnpm --filter @apo/agent-orchestrator build`
```

`main.ts` loads `config.ts`'s Zod-validated `AppConfig` from the environment,
conditionally applies pending migrations (`MIGRATE_ON_BOOT`, default
`true`), builds the service via `createAgentOrchestrator(...)`
(`src/composition-root.ts`), and serves it with `@hono/node-server`, with
the same SIGTERM/SIGINT graceful-shutdown-then-force-exit pattern as
`pay-core`'s and `durable-ledger`'s own `main.ts`.

Required service configuration also includes
`DURABLE_LEDGER_SERVICE_SECRET`: a 32+-character value shared with
durable-ledger and sent as `X-Service-Secret` on workflow start/status calls.
The process refuses to boot without it. Other notable env vars beyond
`DATABASE_URL`/`DURABLE_LEDGER_URL`/`PAYMENT_METHOD_TOKEN`/`PORT`/`HOST`:

- `LLM_MODE` — `mock` (default) or `live`. `mock` needs no API key at all —
  `main.ts` builds `MockLlmClient` and the service is fully runnable without
  any Anthropic credentials.
- `ANTHROPIC_API_KEY` — required, and boot-validated (`loadConfig`'s own
  `superRefine`, re-checked again in `main.ts`'s `buildLlmOptions` — see its
  own doc comment for why both checks exist), the moment `LLM_MODE=live`.
  Never logged.
- `ANTHROPIC_MODEL` — default `claude-sonnet-5`.
- `ANTHROPIC_BASE_URL` — optional HTTPS URL. HTTP development proxies must migrate
  to HTTPS for env configuration. Programmatic adapter URL options and
  `DURABLE_LEDGER_URL` retain their existing contracts.
- `POLICY_ALLOWED_CURRENCIES`, `POLICY_MAX_AUTO_APPROVE_AMOUNT`,
  `POLICY_MAX_HARD_LIMIT_AMOUNT`, `POLICY_DAILY_RATE_LIMIT` — see
  `config.ts` for defaults; `createAgentOrchestrator` runs them through
  `resolvePolicyConfig` at boot, so a bad value (e.g. a zero-decimal
  currency) fails loudly before the service ever starts serving traffic.
- `MIGRATE_ON_BOOT` — default `true`.

`GET /healthz` is liveness-only, deliberately: it does NOT ping Postgres,
`durable-ledger`, or Anthropic. Pinging any of those on every load-balancer
probe interval would be wasteful at best and dangerous at worst — Anthropic
in particular, where a tight probe interval combined with a real outage
could burn paid inference calls on a restart loop instead of just flapping
the process in and out of rotation. See "Why `/healthz` is liveness-only"
above for the fuller argument, which applies identically here.

### Docker

```bash
docker compose up -d --build      # from the monorepo root
```

This now starts all five services — `postgres`, `pay-core`, `inngest`,
`durable-ledger`, and `agent-orchestrator` — and converges on its own:
`agent-orchestrator` waits for `postgres` (migrations) and for
`durable-ledger` to be healthy before Compose considers it startable, and
it runs in `LLM_MODE=mock` with no Anthropic credentials needed by default.
`LLM_MODE=live ANTHROPIC_API_KEY=sk-... docker compose up -d` is the live
path — the key is never written into `docker-compose.yml` itself, only
passed through from the host shell. `PAYMENT_METHOD_TOKEN` defaults to a
demo placeholder and is overridable from the host the same way. As with
both sibling services, the compose healthcheck hits the liveness-only
`/healthz`, so `service_healthy` here means "this process is up," not
"Postgres/durable-ledger/Anthropic are reachable" — see "Why `/healthz` is
liveness-only" above.

## Running the tests

```bash
pnpm install                               # from the monorepo root
pnpm --filter @apo/agent-orchestrator test # unit tests, no external services
pnpm --filter @apo/agent-orchestrator typecheck
pnpm --filter @apo/agent-orchestrator lint
```

Requires Node 24+ and pnpm. No test in this package requires an
`ANTHROPIC_API_KEY` or makes a real network call — `AnthropicLlmClient`'s
own suite (`anthropic-llm-client.test.ts`) exercises it entirely against
`FakeAnthropicMessages` (`fake-anthropic-messages.ts`), an in-process
double for the SDK's narrow `AnthropicMessagesApi` surface.

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
- **Single tool plus parsed prose.** An earlier sketch had the model answer
  in free text (optionally with one "propose a payment" tool) and parse a
  structured decision back out of it for the other two outcomes. Rejected:
  every additional thing a text parser has to recognize (a clarifying
  question, a decline, a refusal, an off-topic reply) is another silent
  misparse waiting to happen. Three tool calls covering the whole
  `AgentProposal` union, with `tool_choice` forcing exactly one, turns every
  one of those into a typed `LlmProtocolError` instead.
- **The SDK's structured-output/`.parse()` feature.** Anthropic's SDK offers
  a client-side parsing/validation helper for exactly this kind of "make the
  model return a typed shape" problem. Rejected here because it would move
  the failure boundary — where a malformed model response turns into a typed
  error — out of code this package owns and into the SDK's own internals,
  which is precisely the boundary `anthropic-llm-client.test.ts` needs to
  control and assert against directly (missing fields, wrong types, two
  simultaneous tool calls, etc.).
- **A real-socket fake server for the vendor API, à la
  `fake-durable-ledger-server.ts`.** Rejected: ADR-0006's case for a real
  `node:http` server over a stub is that only a real socket honestly
  exercises `fetch`/timeout/`AbortSignal` plumbing — but that plumbing isn't
  what's risky in `AnthropicLlmClient`. The risky code is prompt/tool
  assembly and response parsing, which `FakeAnthropicMessages` (an in-process
  double for the SDK's own narrow `AnthropicMessagesApi`) already exercises
  directly, with no timeout/socket machinery of its own to get subtly wrong.

## Roadmap

- [x] Domain: `Intent` state machine, `AgentProposal`
- [x] Policy: pure guardrail rules + `evaluatePolicy`
- [x] `LlmClient` port + `MockLlmClient`
- [x] `AgentCoreClient` port + `durable-ledger` HTTP client
- [x] `IntentRepository` port + Postgres/in-memory adapters
- [x] `app/*`: `SubmitIntent`, `GetIntent`
- [x] `app/*`: `AnswerClarification`
- [x] `app/*`: `RejectIntent`
- [x] `app/*`: `ApproveIntent`
- [x] `AnthropicLlmClient` (live)
- [x] `app/*`: `SyncIntentExecution` (step 8, first slice)
- [x] `config.ts` (step 8, second slice)
- [x] Hono HTTP layer (step 8, third slice)
- [x] Composition root + `main.ts` (step 8, fourth and final slice)
- [x] Auto-approve path: client-supplied `Idempotency-Key` on `POST /intents` + an `Intent.autoApprove` caller (deterministic `Intent.id` via [ADR-0015](../../docs/adr/0015-deterministic-intent-ids-for-auto-approve.md); `AutoApproveIntent` triggers durable-ledger on a fresh `allow`, exactly once)
- [x] Policy rule `merchantMustBeGrounded`: the proposed payee must be a whole token of the intent text ([ADR-0017](../../docs/adr/0017-merchant-must-be-grounded-in-the-intent-text.md); closes the agent-evals merchant-swap finding on the auto-approve path)
- [ ] End-to-end demo scenario
- [x] Step 9: `Dockerfile` + `docker-compose` wiring + CI — the package's
      own `Dockerfile`, a fifth `docker-compose.yml` service wired behind
      `durable-ledger`'s healthcheck, and a `docker images build` step in
      the monorepo CI workflow (`.github/workflows/ci.yml`)
- [x] Also consumed as a library via its `exports` map by `@apo/agent-evals` ([ADR-0016](../../docs/adr/0016-agent-evals-imports-the-built-orchestrator.md))
