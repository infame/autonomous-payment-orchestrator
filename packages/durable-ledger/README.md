# @apo/durable-ledger

[![CI](https://github.com/infame/autonomous-payment-orchestrator/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/infame/autonomous-payment-orchestrator/actions/workflows/ci.yml)

Durable execution and a double-entry ledger, one package
(`packages/durable-ledger`) in the **APO** (Autonomous Payment Orchestrator)
monorepo — a portfolio project. It sits alongside `@apo/pay-core`
(`packages/pay-core`) in the same pnpm workspace; see
[ADR-0004](../../docs/adr/0004-monorepo-not-constellation.md) for why they're
one repository rather than a constellation of five.

`pay-core` gives you operations that are **safe to retry**. `durable-ledger`
uses that to build reliable, resumable multi-step payment workflows on top
— talking to `pay-core` only over its HTTP API, never as an imported
library, and appending immutable double-entry postings to record where money
moved. That boundary is intentional: this package durably orchestrates
`pay-core`, it does not own payment state. Full spec is kept local-only
(`docs/todo/02-durable-ledger.md`, not in this repo); the sections that
matter are summarised below.

## Status: step 9 of 9

This package currently contains the double-entry ledger domain model
(including the reversal factory), the Postgres schema and migration plumbing
for `ledger_entries`, the `LedgerRepository` port + Postgres adapter (plus an
in-memory adapter) for atomic, idempotent posting, a typed `pay-core` HTTP
client with deterministic `Idempotency-Key` generation, a pure
retry-decision policy, the `payment.execute` Inngest workflow with
compensations, and a thin Hono HTTP layer + composition root + `main.ts` —
steps 1-8 of the spec's own implementation order (§13):

1. **`src/domain/`** — `Money`, `LedgerAccount`, `LedgerEntry`,
   `PostingGroup`, and the balance/residual projections. No I/O.
2. **Postgres schema (`ledger_entries`) via Drizzle** — its own `ledger`
   Postgres schema, append-only via a `BEFORE UPDATE OR DELETE` trigger.
3. **`LedgerRepository` port + `PgLedgerRepository`** — atomic, idempotent
   posting of a `PostingGroup`, plus the read paths
   (`findByOperationId`/`findByPaymentId`/`findByAccount`/`getBalance`). See
   "Posting & idempotency" below.
4. **`HttpPayCoreClient`** — a typed HTTP client for `pay-core`'s five
   routes, deterministic `Idempotency-Key` generation, and error
   classification. See "Talking to pay-core" below.
5. **`decideRetry`/`isRetryable`** — a pure retry-decision policy over the
   error classification from step 4: retry or not, and after how long. See
   "Retrying pay-core calls" below.
6. **`payment.execute` workflow on Inngest** — authorize -> capture -> post a
   ledger entry, happy path + retries. See "Running the workflow" below.
7. **Compensations (this step)** — a hand-rolled decision table + unwind that
   cancels/refunds a `pay-core` payment and reverses its ledger posting when
   a later step fails terminally, plus `PostingGroup.reversalOf` (deferred
   since step 1). See "Compensations (sagas)" below.
8. **A thin Hono HTTP layer (this step)** — `createLedgerApp` (trigger,
   status, and ledger-read routes), a composition root, Zod-validated
   config, and `main.ts`. See "HTTP surface" and "Running the service"
   below.
9. Tests land alongside each step above.

Step 9 (a `Dockerfile` and CI) is now done — see "Docker" under "Running the
service" below and `.github/workflows/ci.yml`.

## The domain model

Double-entry, not a mutable balance column: every operation posts **at
least two entries whose amounts sum to zero across debit and credit**, and
an account's balance is a *projection* over the append-only entry log, never
a stored field. See `docs/todo/02-durable-ledger.md` §3 for the full
rationale (auditability, no lost history, no lost updates under
concurrency).

- `LedgerAccount` — `customer:<id>`, `merchant:<id>`, or
  `acquirer_clearing` (a clearing/liability account, no subject).
- `LedgerEntry` — one debit or credit line, always positive, sign lives in
  `direction`.
- `PostingGroup.create(...)` — the **only** way to construct a valid set of
  entries; it enforces every invariant (≥2 entries, at least one debit and
  one credit, positive amounts, one currency, balanced totals, no duplicate
  `(account, direction)` pair, valid UUIDs) and throws a specific typed
  `LedgerError` subclass otherwise. `forCapture`/`forRefund` are the two
  concrete postings this package currently knows how to build (§3.3):
  capture debits `acquirer_clearing` and credits the merchant; refund is
  the exact reverse.
- `PostingGroup.reversalOf({ original, operationId, now? })` (added this
  step, deferred since step 1) — the mirror image of an *already-posted*
  group: every debit becomes a credit and vice versa, same accounts,
  amounts, and currency, tagged `entryType: "reversal"` with
  `reversesOperationId` set to the original operation. Takes the STORED
  entries (`LedgerRepository.findByOperationId`'s result), not a
  `PostingGroup` — a `PostingGroup` can't be rehydrated from storage today,
  and what must be mirrored is what actually landed in the journal. Flipping
  every direction automatically preserves all of `create`'s invariants
  (count, "at least one of each direction", balance — the swapped totals are
  still equal since the originals were), so `reversalOf` delegates straight
  to `create` after building the flipped entries; it separately rejects a
  new `operationId` equal to the original's (that would collide with
  `LedgerRepository.post`'s idempotency key) and a reversal-of-a-reversal.
  **`reversalOf` is not `forRefund`**: `reversalOf` undoes *this package's
  own* capture posting as part of a compensation (below); `forRefund` will
  record a merchant-initiated refund as its own top-level operation once a
  `payment.refund` workflow exists.
- `balances.ts` — pure projections (`balanceOf`, `balanceSheet`,
  `residuals`, `isBalanced`, `assertZeroSum`) over any
  `Iterable<LedgerEntry>`. No port, no I/O — a later Postgres-backed step
  feeds these a query result the same way today's tests feed them an
  in-memory array.

**Sign convention (§3.4):** a balance is `SUM(credit) − SUM(debit)`. After a
capture, `merchant:<id>` is `+amount` and `acquirer_clearing` is
`−amount` — the clearing account runs *negative*. That's correct, not a
bug: it's a liability/transit account, not a store of value, and its
negative balance is exactly offset by the merchant's positive one. See the
named test in `balances.test.ts` asserting this.

Every entry also carries `entryType` (`"capture" | "refund" | "reversal"`)
and `reversesOperationId`. Both fields existed from step 1, ahead of the
reversal *logic* (`reversalOf`, above) landing in this step — so the
Postgres schema in step 2 was a mechanical transcription of this shape
rather than a migration later.

## Posting & idempotency

`LedgerRepository.post(group)` (`src/ports/ledger-repository.ts`,
`PgLedgerRepository` in `src/adapters/persistence/drizzle/pg-ledger-repository.ts`)
appends every entry of a `PostingGroup` atomically and idempotently on
`operationId`.

- **Why a Postgres advisory lock, not just "insert and catch the unique
  violation".** The schema's `(operation_id, account, direction)` unique
  index (`schema.ts`) only stops a second insert that collides on all three
  columns. Two concurrent `post()` calls for the same `operationId` but
  *disjoint* accounts — one posting to `merchant:a`, a conflicting one to
  `merchant:b` — share no row the index could collide on, so relying on the
  index alone would let both inserts succeed and leave two different
  postings under one `operationId`. `post()` instead takes a
  session-scoped `pg_advisory_xact_lock(namespace, hashtext(operationId))`
  before it reads or writes anything for that operation, inside the same
  transaction as the read-then-insert — so the second caller for a given
  `operationId` always sees the first caller's committed rows before
  deciding whether to no-op or insert. The unique index stays as a backstop
  (`DuplicatePostingError` in `errors.ts`) for the case that lock
  serialization is itself broken, not as the primary mechanism.
- **Why the fingerprint excludes `id`/`createdAt`.** `PostingGroup.create`
  mints a fresh `randomUUID()` per entry on every call
  (`src/domain/entry.ts`), so a retried workflow step legitimately
  reconstructs "the same" logical group with different row ids and a
  different timestamp. `fingerprintOf` (`src/domain/posting-fingerprint.ts`)
  builds its identity from the fields that make a posting *logically* the
  same — account, direction, amount, currency, paymentId, entryType,
  reversesOperationId — sorted so entry order doesn't matter either.
  `post()` compares the attempted group's fingerprint against the stored
  entries' fingerprint: equal means "this is the same retry, return the
  stored result"; different means `PostingConflictError` — the caller's key
  logic changed under a stable `operationId`, which is a bug, not a retry.
- **`getBalance` vs `balanceOf`.** `balances.ts`'s `balanceOf` is the pure
  specification of what a balance *means* (`SUM(credit) − SUM(debit)` over
  an `Iterable<LedgerEntry>`, no I/O). `PgLedgerRepository.getBalance` is
  the pushed-down implementation of the same computation as a SQL
  `SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)`
  aggregate, so a balance query doesn't have to pull every row for an
  account into the application just to sum them. The two are pinned
  together by integration tests asserting
  `getBalance(a, c)` equals `balanceOf(await findByAccount(a, c), a, c)` on
  the same data — including the `acquirer_clearing` negative-sign
  convention (see "Sign convention" above).

## Talking to pay-core

`HttpPayCoreClient` (`src/adapters/http/pay-core-client.ts`) implements the
`PayCoreClient` port (`src/ports/pay-core-client.ts`) against pay-core's five
HTTP routes: `POST /payments`, `.../capture`, `.../refund`, `.../cancel`,
`GET /payments/:id`. `baseUrl` is required with no default; the per-request
timeout defaults to `DEFAULT_REQUEST_TIMEOUT_MS` (10s) and can be overridden
globally (constructor) or per call (`RequestOptions.timeoutMs`).

**Gotcha, do not "fix" this:** a `201` response from `createPayment` can
carry `status: "failed"` in the body. pay-core's `CreatePayment` use-case
catches a provider decline internally and persists a failed payment rather
than raising an HTTP error — see `packages/pay-core/src/app/create-payment.ts`.
`HttpPayCoreClient.createPayment` resolves normally in that case; it does
not throw. The pinning test is named accordingly in
`pay-core-client.test.ts`.

Error classification (`src/ports/pay-core-errors.ts`), the caller-side
mirror of pay-core's own "Provider failures: terminal vs retryable" split
(`packages/pay-core/README.md`):

| HTTP status | Error class | `retryable` |
|---|---|---|
| network failure (no response) | `PayCoreNetworkError` | true |
| request timeout | `PayCoreTimeoutError` | true |
| caller's own `AbortSignal` fired | `PayCoreRequestCanceledError` | false |
| 400 | `PayCoreBadRequestError` | false |
| 402 | `PayCoreDeclinedError` | false |
| 404 | `PayCoreNotFoundError` | false |
| 409 | `PayCoreIdempotencyConflictError` | false |
| 422 | `PayCoreIllegalStateError` | false |
| 503 | `PayCoreUnavailableError` | true |
| any other non-2xx | `PayCoreUnexpectedResponseError` | `status >= 500 \|\| status === 429 \|\| status === 408` |
| 2xx with a body that fails schema validation | `PayCoreMalformedResponseError` | false |

`stepIdempotencyKey(runId, stepName)` (`src/workflow/idempotency-key.ts`) is
`sha256(runId + ":" + stepName)`, hex-encoded. It's deterministic on
purpose: an Inngest step re-run (step 6) produces the identical key, so
pay-core replays its stored idempotency record instead of performing a
second effect (double-charge, double-refund, …).

**Exactly-once gap, out of scope for this client.** pay-core's
`CreatePayment` calls the provider *before* persisting the payment (see
`create-payment.ts`). If `createPayment` times out, `PayCoreTimeoutError`
is correctly `retryable: true` in the sense that retrying with the same
`Idempotency-Key` guarantees "at most one recorded payment" — but it does
NOT guarantee "at most one PSP hold": the first attempt may have already
authorized with the provider before the response was lost. Closing that gap
(e.g. checking provider state before a second authorize) is a property of
`pay-core` itself, not something this HTTP client can paper over, and is
recorded here so it isn't silently assumed away.

## Retrying pay-core calls

`decideRetry(error, attempt, options?)` (`src/workflow/retry-policy.ts`) is a
**pure decision function**: given a failed call's error and how many attempts
have already happened, it answers "retry or not, and after how long" — it
does not sleep, loop, or perform the retry itself.

**Formula** (equal jitter, server hint as a floor):

```
exp      = min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs)
jittered = exp / 2 + rng() * (exp / 2)        // ∈ [exp/2, exp)
delayMs  = min(round(max(jittered, hint)), maxDelayMs)
```

With `DEFAULT_RETRY_POLICY` (`maxAttempts: 4, baseDelayMs: 500,
backoffMultiplier: 2, maxDelayMs: 30_000`):

| Attempt | Delay range (no server hint) |
|---|---|
| 1 | 250 – 500ms |
| 2 | 500ms – 1s |
| 3 | 1 – 2s |
| 4th failure | `attempts_exhausted` — no attempt 5 |

`maxAttempts: 4` isn't arbitrary: the simulator's `sim.fail_then_succeed`
directive defaults to 1 failure (`DEFAULT_FAILURES` in
`packages/pay-core/src/adapters/simulator/directives.ts`), so a default
policy comfortably absorbs the demo's own flakiness while keeping the
worst-case wall-clock under ~4 seconds absent a server hint.

A `PayCoreUnavailableError` carrying `retryAfterMs` (from pay-core's
`Retry-After` header) acts as a **floor** via `max(jittered, hint)` — it can
only extend a wait, never shorten one that's already escalated, and a
sub-second hint (which serializes to the header value `"0"`, since pay-core
emits `Math.ceil(ms / 1000)`) safely falls through to normal backoff instead
of forcing a hot loop.

An error that isn't a `PayCoreClientError` at all (a `LedgerError`, a
`PostingConflictError`, a plain bug) is never retried —
`reason: "unclassified_error"` — because every error `HttpPayCoreClient` can
actually throw is already funneled through `payCoreErrorFor` into a
`PayCoreClientError`; anything else is a different kind of failure that
won't un-happen on a retry.

**Inngest owns the retry loop here — do not add a `withRetry` helper.** This
package deliberately ships no attempt loop. The `payment.execute` workflow
calls `decideRetry` inside a `step.run(...)`, and Inngest's own step-retry
mechanism (durable across a process crash, unlike an in-process
`setTimeout`) does the actual waiting and re-invoking — rethrow the server's
hint as Inngest's own retry-delay signal on `shouldRetry: true`, and a
non-retriable signal otherwise, routing `terminal_error`/`unclassified_error`
to compensation and `attempts_exhausted` to `needs_review` (see
[ADR-0007](../../docs/adr/0007-inngest-owns-the-retry-loop.md) for the full
reasoning, including the retry-amplification math a nested loop would cause,
and its "Verified in step 6" note for what's now confirmed against
`inngest@4.20.0`). The workflow configures Inngest's own `retries` option as
`DEFAULT_RETRY_POLICY.maxAttempts - 1` (`inngestRetriesFor`,
`src/workflow/inngest-errors.ts`) so the two ceilings stay pinned together.

## Running the workflow

`createPaymentExecuteFunction(deps)` (`src/workflow/payment-execute.ts`)
builds the `payment.execute` Inngest function: given a
`payment/execute.requested` event (`src/workflow/events.ts`, Zod-validated
via `eventType`), it runs three durable steps in order —

1. **`authorize`** — `payCore.createPayment(...)`, keyed with
   `stepIdempotencyKey(runId, "authorize")`. If the payment resolves with
   `status !== "authorized"` (pay-core's 201-with-`status:"failed"` decline
   case — see "Talking to pay-core" above), the function fails cleanly via
   `NonRetriableError` and `capture` is never attempted; there is nothing to
   compensate, since authorize never actually succeeded.
2. **`capture`** — `payCore.capturePayment(...)`, keyed with
   `stepIdempotencyKey(runId, "capture")` (a DIFFERENT key from `authorize`'s
   — see "Two derivations, one input" below).
3. **`post-ledger`** — builds a `PostingGroup.forCapture(...)` and calls
   `ledger.post(...)`, keyed with `stepOperationId(runId, "post-ledger")`
   (NOT `stepIdempotencyKey` — again, see below).

Each `step.run(...)`'s catch block calls `rethrowForInngest` (`src/workflow/inngest-errors.ts`),
which runs `decideRetry` and translates the decision into `RetryAfterError`
(retry) or `NonRetriableError` (terminal/exhausted) — **this must happen
INSIDE the `step.run` callback, never in the surrounding handler**: Inngest
does not rethrow the original error object to the outer handler, so
`error instanceof PayCoreClientError` only holds true inside the callback
(see `rethrowForInngest`'s own doc comment, and ADR-0008).

A terminal failure or exhausted retries no longer just fails the Inngest
function — it routes through the compensation logic described in
"Compensations (sagas)" below, which decides whether to unwind what already
succeeded or send the run straight to `needs_review`.

**Constructing it — real deps vs in-memory/test deps.** `createPaymentExecuteFunction`
takes `{ inngest, payCore, ledger, retry? }` as a plain object, not
constructed internally, specifically so callers can swap implementations
without touching this file:

```ts
// Real deps — this is what src/composition-root.ts's createDurableLedger
// actually wires; see "Running the service" below to run it for real:
import { createInngestClient } from "@apo/durable-ledger"; // src/adapters/inngest/client.ts
import { HttpPayCoreClient } from "@apo/durable-ledger"; // src/adapters/http/pay-core-client.ts
import { PgLedgerRepository } from "@apo/durable-ledger"; // src/adapters/persistence/drizzle/pg-ledger-repository.ts

const fn = createPaymentExecuteFunction({
  inngest: createInngestClient({ isDev: true }),
  payCore: new HttpPayCoreClient({ baseUrl: "http://localhost:3000" }),
  ledger: new PgLedgerRepository(db),
});
```

```ts
// Test / local-demo deps — no I/O, no Docker, no dev server:
import { InMemoryLedgerRepository } from "@apo/durable-ledger"; // src/adapters/memory/in-memory-ledger-repository.ts
import { FakePayCoreClient } from "./fake-pay-core-client.js"; // test-only, not exported

const fn = createPaymentExecuteFunction({
  inngest: new Inngest({ id: "test" }),
  payCore: new FakePayCoreClient(),
  ledger: new InMemoryLedgerRepository(),
});
```

`payment-execute.test.ts` drives the second shape through `@inngest/test`'s
`InngestTestEngine` — no Docker, no real Inngest server; that stays true for
this file's own tests. **This package now also has a real `main.ts` and an
`inngest/hono` `serve()` endpoint** (this step — see "Running the service"
below), so `payment.execute` can additionally be driven end-to-end against a
live local Inngest dev server, not just exercised in-process via the test
engine.

**Two derivations, one input: `stepIdempotencyKey` vs `stepOperationId`.**
Both take `(runId, stepName)` and are deterministic (same input -> same
output, so a retried step reproduces the same value), but they are NOT
interchangeable:

- `stepIdempotencyKey(runId, stepName)` (`src/workflow/idempotency-key.ts`)
  returns a 64-char sha256 hex string, sent to pay-core as the
  `Idempotency-Key` header.
- `stepOperationId(runId, stepName)` (`src/workflow/operation-id.ts`)
  returns a deterministic RFC-9562 v8 UUID, used as `PostingGroup`'s
  `operationId`.

The reason a second derivation exists at all: `PostingGroup.create`
(`src/domain/entry.ts`) requires `operationId` to be UUID-shaped
(`assertUUID`'s regex) — a 64-char sha256 hex string fails that check
outright. Passing one where the other is required either throws or silently
posts under the wrong identity, so `payment-execute.ts` never substitutes
one for the other, and `operation-id.test.ts` pins
`stepOperationId(...) !== stepIdempotencyKey(...)` directly so this doesn't
regress silently.

**Known limitation: `RetryAfterError`'s whole-second quantization.**
`decideRetry`'s `delayMs` is a millisecond value with sub-second precision
(equal-jitter backoff, see "Retrying pay-core calls" above), but Inngest's
own `RetryAfterError(message, retryAfter)` (confirmed against
`inngest@4.20.0`) converts its `retryAfter` argument to
`Math.ceil(ms / 1000)` whole seconds before handing it to Inngest's retry
scheduler. `rethrowForInngest` passes `decision.delayMs` straight through —
there is no workaround here, sub-second backoff precision is simply not
representable on Inngest's actual retry-delay API, and this is the same
"pay-core's own `Retry-After` header rounds up to whole seconds" rounding
this package's `retryAfterMsOf`/`backoffDelayMs` already contend with (see
"Retrying pay-core calls" above) — one more place the same rounding shows
up, not a new problem.

**Known limitation: the `runId`-seeded idempotency key under Inngest
Replay.** `stepIdempotencyKey`/`stepOperationId` are deterministic functions
of `runId`, per spec §2/§4.2's literal formula — kept as specified even
though it has a real, understood interaction with Inngest's Replay feature:
replaying a run assigns it a NEW `runId` (that's what makes it a distinct
run in Inngest's UI/API), which means a replayed `authorize`/`capture` step
computes a DIFFERENT `Idempotency-Key` than the original run used — pay-core
sees an unrecognized key and performs a genuine SECOND effect (a second
authorize/capture), not a replay of the first one's stored result. This is
a spec-mandated, accepted limitation of the current formula, not an
oversight; closing it (e.g. seeding the key from something stable across a
Replay, such as the triggering event's own id) is out of scope for this
step. **This now also covers compensating steps** (`compensate-authorize`,
`compensate-capture`, `compensate-post-ledger`, added this step): a Replay
that re-runs a compensation computes a new key/operationId the same way and
would perform a genuine second cancel/refund/reversal, for the identical
reason. Separately — and this is a property of `@inngest/test`, not of
production Inngest — reusing the SAME `runId` across two separate
`InngestTestEngine` instances (simulating "the same run happening twice")
correctly produces two independent `post-ledger` invocations with a stable
`operationId`, but reusing the same `InngestTestEngine` *instance* for two
`.execute()` calls does not: its own `mockHandlerCache` persists across
calls and can mask a step's second real invocation behind a stale cached
result. `payment-execute.test.ts`'s idempotent-re-execution test constructs
a fresh `InngestTestEngine` per run for exactly this reason.

## Compensations (sagas)

`payment.execute` has no separate saga library or engine — spec §5 explicitly
calls for a hand-rolled step registry, and this repo has already rejected
pulling one in for the identical "second mechanism duplicating Inngest"
reason it rejected an outbox dispatcher (ADR-0003, cited again in
[ADR-0007](../../docs/adr/0007-inngest-owns-the-retry-loop.md)). The registry
is a small pure decision table (`planUnwind`) plus a sequential executor
(`runUnwind`), both in `src/workflow/compensation.ts`.

**Decision table**, keyed on `WorkflowStepFailedError.reason`, not on which
step failed:

| Failing step | Reason | What already happened | Route | Compensating action(s) |
|---|---|---|---|---|
| `authorize` | any | nothing | rethrow verbatim | — |
| `authorize` returns 201+`status:"failed"` | n/a | nothing | rethrow verbatim | — |
| `capture` | `terminal_error` | authorization hold | **compensate** | `cancel-authorization` |
| `capture` | `attempts_exhausted` | authorization hold, outcome unknown | **`needs_review`** | — |
| `capture` | `unclassified_error` | authorization hold | **`needs_review`** | — |
| `post-ledger` | `unclassified_error` (the only reason it can ever produce — a `LedgerError` is never a `PayCoreClientError`) | authorize + capture, no ledger row | **`needs_review`** | — |
| any compensating step | any | partially unwound | **`needs_review`**, naming both the original step and the failed compensation | — |

Three rules behind the non-obvious rows:

- **`attempts_exhausted` never auto-compensates.** Exhausted retries mean
  `pay-core` is unhealthy or unreachable — a compensating cancel/refund would
  target the same unavailable dependency, and the true state is genuinely
  unknown (the same "at most one recorded payment, not at most one PSP hold"
  gap already documented under "Talking to pay-core"). A definitive
  `terminal_error` from a *healthy* `pay-core` is the opposite: a reliable
  "this did not happen", so unwinding is both safe and correct.
- **`post-ledger` failing never triggers a refund.** A reversal needs the
  original posted entries (`reversalOf`, above) — if the post itself failed,
  `findByOperationId` returns nothing to mirror. Worse, the failing component
  IS the ledger, so refunding here would move real money with zero record of
  either leg. Every failure this step can actually produce today is a bug or
  an infrastructure fault, and refunding a customer because of our own
  bookkeeping bug is worse than escalating loudly.
- **Refund subsumes cancel.** Once a payment is captured, only
  `refund-capture` runs — issuing `cancelPayment` on an already-captured
  payment is itself an illegal transition (`pay-core` would answer 422),
  which would turn a *successful* compensation into a spurious
  `needs_review`. When both a capture and a ledger posting exist, the order
  is **refund, then reversal** — deliberately the opposite of "unwind in
  strict reverse step order": never record a ledger movement for money that
  wasn't actually returned. If the refund fails, the ledger is merely stale
  (safe); reversing first and having the refund then fail would leave the
  ledger actively lying.

**Step naming.** Each compensating action gets its own step name
(`compensate-authorize`/`compensate-capture`/`compensate-post-ledger`),
deliberately distinct from the step it compensates — reusing the original
step's `Idempotency-Key` would send a *different* request body under a
*known* key and trip `pay-core`'s 409 idempotency-conflict detection:

| Compensating step | pay-core `Idempotency-Key` | ledger `operationId` |
|---|---|---|
| `compensate-authorize` | `stepIdempotencyKey(runId, "compensate-authorize")` | — |
| `compensate-capture` | `stepIdempotencyKey(runId, "compensate-capture")` | — |
| `compensate-post-ledger` | — | `stepOperationId(runId, "compensate-post-ledger")` |

**Reversal, never deletion.** `reverse-posting` calls `PostingGroup.reversalOf`
and posts it as a brand-new operation — it never touches, deletes, or
mutates the original entries (the schema's append-only trigger would refuse
that anyway). Both the original capture and its reversal remain in the
journal forever; the account balances just net back toward zero.

**The `needs_review:` message prefix.** Every give-up path's `NonRetriableError`
message starts with the literal token in `NEEDS_REVIEW_MARKER`
(`"needs_review:"`); a successfully-compensated failure's message never
contains it. This is a deliberate, greppable distinction for whoever reads
Inngest's dashboard/logs today and step 8's `GET /workflows/:runId` later —
see
[ADR-0009](../../docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md)
for why the failure reason has to travel as a message substring at all
rather than a structured field.

**Why `runPaymentExecute`/`WorkflowStep` exist as a separate seam.**
`@inngest/test`'s `InngestTestEngine` cannot execute any handler code after a
step fails (two independent, verified blockers — see ADR-0009), which makes
compensation logic untestable through it. `src/workflow/workflow-step.ts`
declares the narrow `WorkflowStep` interface (just the one `run` method
`payment.execute` actually uses) that Inngest's real `step` satisfies
structurally with zero casts, and `runPaymentExecute` is the whole workflow
body written against that interface instead of Inngest's `ctx` directly.
`createPaymentExecuteFunction` is now a one-line adapter. Production callers
never see this split — only `payment-execute-compensation.test.ts`
(`FakeWorkflowStep`) and `payment-execute.test.ts` (`InngestTestEngine`, for
the happy path and pre-effect failures) drive it differently.

## HTTP surface

`createLedgerApp(deps)` (`src/adapters/http/app.ts`) builds the driving HTTP
adapter — a Hono app over `LedgerRepository` and a new `WorkflowRuns` port
(`src/ports/workflow-runs.ts`). No auth, matching `pay-core`'s own scope.

| Route | What it does |
|---|---|
| `POST /workflows/payment` | Validates the body against `paymentExecuteRequestedSchema`, optionally reads an `Idempotency-Key` header (see "De-duplicating a trigger" below), calls `WorkflowRuns.startPaymentExecute` (→ `inngest.send(...)`), returns `202 { eventId, statusUrl }` — always, whether or not the request deduplicated. |
| `GET /workflows/:eventId` | Returns a `WorkflowRunSnapshot` — `status` (`queued`/`running`/`completed`/`failed`/`cancelled`), `runId`, timestamps, and `needsReview`/`failureMessage`. `404` if the engine doesn't recognize the id. |
| `GET /ledger/entries?paymentId=…` or `?operationId=…` | Exactly one of the two query params, enforced by a Zod `.refine`. An empty result is `200 { entries: [] }`, never `404`. |
| `GET /ledger/accounts/:account/balance?currency=EUR` | `:account` is `LedgerAccount`'s serialized form (`merchant:42`, `acquirer_clearing`), percent-decoded then parsed. |
| `GET /healthz` | `200 { status: "ok" }`. |

Errors follow the same envelope as `pay-core`: `{ error: { code, message, details? } }`
(`src/adapters/http/server-error-mapper.ts`). One deliberate divergence from
`pay-core`'s own convention: `InvalidAccountError`/`InvalidMoneyError`/`CurrencyMismatchError`
map to **400**, not 422, here — in this HTTP layer they only ever arise from
parsing a request path/query parameter (a malformed request), never from a
rejected state transition, so 400 is the honest status.

**Looking a run up by a caller-chosen id is still impossible; preventing a
duplicate trigger is not the same thing, and is now possible.** `GET
/workflows/:eventId` only ever accepts Inngest's own server-assigned event
id (a ULID) — Inngest's REST API rejects a non-ULID id outright (`GET
/v1/events/my-id/runs` → `400 Invalid event ID`, verified). A caller that
loses the `202` response's `eventId` still cannot re-find that run by any
value it chose itself; that half of the old claim stands, see
[ADR-0010](../../docs/adr/0010-run-status-from-inngest-not-a-workflow-runs-table.md).
What changed: a caller can now supply an `Idempotency-Key` header on the
*trigger* itself to stop a retried/duplicated `POST /workflows/payment` from
starting a second, independent run — see
[ADR-0013](../../docs/adr/0013-optional-trigger-idempotency-key.md) and "De
-duplicating a trigger" below. Dedup and lookup are different capabilities;
this section used to conflate them.

### De-duplicating a trigger

An optional `Idempotency-Key` header on `POST /workflows/payment` is
forwarded to Inngest as the triggering event's own `id`, namespaced
`payment-execute:<merchantId>:<key>`. Two requests with the same key
(for the same merchant) produce two different `202` responses (two
different `eventId`s) but Inngest starts only **one** run — see
[ADR-0013](../../docs/adr/0013-optional-trigger-idempotency-key.md) for the
verified mechanics. Four things to know before using it:

- **The "dud handle" consequence.** The deduplicated request's `eventId` is
  real, but will never have a run attached to it — `GET
  /workflows/:eventId` for it reads `queued` forever. That is the expected,
  documented outcome, not a bug to chase.
- **Namespacing by merchant only partially closes the collision risk.**
  Two different merchants choosing the same key independently can't
  collide with each other, but the same merchant reusing the same key for
  two genuinely different payments still collides — silently, with the
  same dud-handle outcome. Choose a key that's unique per logical payment
  attempt (e.g. an intent id), not a constant or a shared counter.
- **Weaker than pay-core's own `Idempotency-Key`.** Same header name,
  different contract: pay-core (`packages/pay-core`) stores the first
  call's result and replays it on a same-key retry, 409ing a
  same-key/different-body retry as a detected conflict. Here, a
  same-key/different-body retry is **silently discarded** — there is no
  stored result to replay and no conflict detection at all.
- **Never derive this key from a credential or PII.** It is stored by, and
  visible in, Inngest's own dashboard/event log — the same boundary
  [ADR-0012](../../docs/adr/0012-payment-method-token-is-supplied-not-proposed.md)
  draws around `paymentMethodToken` applies to this key too.

**`GET /workflows/:eventId` reads run status live from Inngest's own REST
API**, not from any table this package owns — `InngestWorkflowRuns`
(`src/adapters/inngest/inngest-workflow-runs.ts`) makes two sequential calls
(`/v1/events/:id/runs` to resolve the run id, then `/v1/runs/:id` for the
authoritative status — the second call's answer always wins over the
first's, which can report a stale status) and parses both through the
*response envelope's* own `status` field rather than the HTTP status code,
since Inngest's dev server answers `200` even for its own errors. `needsReview`
is derived by checking a failed run's output for the literal
`NEEDS_REVIEW_MARKER` string exported from `src/workflow/compensation.ts` —
the dead-letter signal [ADR-0009](../../docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md)
designed is readable through this endpoint verbatim, with no extra plumbing.
See ADR-0010 for the full reasoning and the verified API quirks.

## Running the service

```bash
docker compose up -d                          # from the monorepo root; postgres:17-alpine on :5433
npx inngest-cli@latest dev                     # a local Inngest dev server on :8288

DATABASE_URL=postgres://apo:apo@localhost:5433/apo \
PAY_CORE_URL=http://localhost:3000 \
pnpm --filter @apo/durable-ledger start        # after `pnpm --filter @apo/durable-ledger build`
```

`main.ts` loads `config.ts`'s Zod-validated `AppConfig` from the environment,
conditionally applies pending migrations (`MIGRATE_ON_BOOT`, default `true`),
builds the service via `createDurableLedger(...)` (`src/composition-root.ts`),
and serves it with `@hono/node-server`, with the same SIGTERM/SIGINT
graceful-shutdown-then-force-exit pattern as `pay-core`'s `main.ts`.

Notable env vars beyond `DATABASE_URL`/`PAY_CORE_URL`/`PORT`/`HOST`: `INNGEST_DEV`
(default `true` — talks to a local dev server with no keys required);
`INNGEST_BASE_URL` (default `http://localhost:8288`); `INNGEST_SERVE_PATH`
(default `/api/inngest` — where the Inngest dev server discovers and calls
this service); `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` (required, and
validated at boot via a `superRefine`, the moment `INNGEST_DEV=false` — i.e.
Inngest Cloud). `createDurableLedger` builds `createPaymentExecuteFunction(...)`
and passes it straight into `inngest/hono`'s `serve({ client, functions })`
inline, in one expression — never through an intermediately-annotated
variable, the same defensive shape `payment-execute.ts` uses, since that's
the exact neighborhood where [ADR-0008](../../docs/adr/0008-inngest-v4-and-workflow-wiring.md)'s
type-inference trap previously showed up (this step's own investigation
found `inngest/hono`'s looser typing likely avoids it here, but the shape
costs nothing to keep).

### Docker

```bash
docker compose up -d --build      # from the monorepo root
```

This now starts all four services — `postgres`, `pay-core`, `inngest` (the
Inngest dev server), and `durable-ledger` — and converges on its own,
without a manual restart: the Inngest dev server polls
`http://durable-ledger:3100/api/inngest` every few seconds until this
service answers, rather than requiring it to already be up when `inngest`
starts. The non-Docker instructions above remain the faster inner loop for
local development.

Two things worth knowing: the `inngest` service keeps its run history
in-memory (no `--persist` volume, matching local `npx inngest-cli dev`
behavior), so `docker compose down` discards it by design; and `/healthz`
deliberately only checks this service's own liveness, not `pay-core`'s or
Inngest's reachability — the same shallow contract as `pay-core`'s own
`/healthz`.

## Why a duplicated `Money`, not shared with `@apo/pay-core`

`src/domain/money.ts` is a deliberate copy of `pay-core`'s `Money`, not
an oversight. Two independent reasons: `pay-core` has no
`main`/`types`/`exports` field in its `package.json`, so nothing outside
that package can actually `import` from it as a workspace dependency today;
and even if it could, sharing the type would quietly couple two packages
that the spec (§1, §2) deliberately keeps talking to each other only over
HTTP. Recorded as [ADR-0005](../../docs/adr/0005-duplicate-money-across-packages.md);
revisit if a third package ever needs the same value object.

## Running

```bash
pnpm install                            # from the monorepo root
pnpm --filter @apo/durable-ledger test  # unit tests, no external services
pnpm --filter @apo/durable-ledger typecheck
pnpm --filter @apo/durable-ledger lint
```

Requires Node 24+ and pnpm.

### Running the integration tests

```bash
docker compose up -d                                    # from the monorepo root; postgres:17-alpine on :5433
DATABASE_URL=postgres://apo:apo@localhost:5433/apo pnpm --filter @apo/durable-ledger db:migrate

pnpm --filter @apo/durable-ledger test:integration       # real-Postgres suites (*.integration.test.ts)
```

`pnpm --filter @apo/durable-ledger test` (no flags) never touches Postgres —
`vitest.config.ts` excludes `*.integration.test.ts` — so the default test
run stays green without Docker. `test:integration` defaults
`TEST_DATABASE_URL` to the `apo_test` database above if unset, and fails
loudly (not silently skips) if Postgres isn't reachable.

This package's tables live in their own `ledger` Postgres schema, not
`public`, even though they share one Postgres instance with `pay-core`
(`docker-compose.yml`): namespace isolation, so `ledger_entries` can never
collide with one of pay-core's tables, and migration-journal isolation, so
applying this package's migrations (tracked at
`ledger.__drizzle_migrations`) can never affect pay-core's own migration
journal or vice versa. See `src/adapters/persistence/drizzle/schema.ts` for
the full rationale.

## Roadmap

- [x] Domain: `Money`, `LedgerAccount`, `LedgerEntry`, `PostingGroup`,
      balance/residual projections
- [x] Postgres schema (`ledger_entries`, append-only, own `ledger` schema)
- [x] Atomic multi-entry posting with a real DB transaction
- [x] `pay-core` HTTP client + deterministic `Idempotency-Key`
- [x] `decideRetry`/`isRetryable` retry policy (pure — no loop; Inngest owns
      the actual retry loop, see ADR-0007)
- [x] `payment.execute` Inngest workflow (happy path + retries, no
      compensations yet — see ADR-0008)
- [x] Sagas + reversal postings (compensations) — hand-rolled decision table
      (`planUnwind`/`runUnwind`), `PostingGroup.reversalOf`
- [x] Hono HTTP layer — trigger/status/ledger-read routes, composition root,
      `main.ts`; run status read live from Inngest's own API (ADR-0010)
- [x] Dockerfile + CI — the package's own `Dockerfile`, `docker-compose.yml`
      wiring for a real Inngest dev server, and the monorepo CI workflow
      (`.github/workflows/ci.yml`)
- [x] Follow-up: optional `Idempotency-Key` header on `POST
      /workflows/payment`, forwarded to Inngest as its event dedup id —
      discovered while planning `agent-orchestrator`'s `ApproveIntent`
      (ADR-0013)
