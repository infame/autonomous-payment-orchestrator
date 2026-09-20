# 15. Deterministic intent ids for auto-approve

Date: 2026-09-19

## Status

Accepted

## Context

`Intent.autoApprove` (`domain/intent.ts`) — the domain's own `proposed →
executing` transition for the case where a payment proposal's *first*
policy pass already returned `allow` — had zero production callers until
this change. Only tests constructed it directly, as a seeding/transition
helper. `SubmitIntent`/`AnswerClarification` deliberately never persist an
`allow` verdict (`apply-policy.ts`'s own header: `dailyRateLimit` is
time-dependent, so a stored "allow" from submission time would be stale by
whenever a future use-case actually claimed and executed it), and nothing
else ever re-evaluated policy on a `proposed` intent to *act* on a fresh
`allow`. So an intent whose first policy pass was `allow` sat at `proposed`
forever — only `needs_approval → executing`, via the human-approval path
(`ApproveIntent`), was reachable.

Wiring a caller for `Intent.autoApprove` runs straight into a problem
[ADR-0013](0013-optional-trigger-idempotency-key.md) already solved once,
for `ApproveIntent`, but does not automatically solve here:
`Intent.id` is minted *before* any policy decision exists — inside
`SubmitIntent`, via `randomUUID()`, at intent-creation time, long before an
LLM proposal or a policy verdict exists to act on. `ApproveIntent` gets to
reuse that already-durable, already-unique `Intent.id` as durable-ledger's
`Idempotency-Key` (ADR-0013) because by the time `ApproveIntent` runs, the
row has existed, unchanged, since submission — a retry of `POST
/intents/:id/approve` addresses the same already-persisted id every time.

`SubmitIntent` has no such luxury. If auto-approve were wired to trigger
durable-ledger inline, from *within* `SubmitIntent`, on the very first `POST
/intents` call that resolves to `allow`, a naive implementation would call
`Intent.submit` with a fresh `randomUUID()` on every invocation — including
a *retried* `POST /intents` (a client-side timeout retry, an at-least-once
queue redelivery, a double-click). Two calls carrying the same logical
request would mint two different `Intent.id`s, and therefore two different
ADR-0013 dedup keys at the durable-ledger boundary. ADR-0013's own
exactly-once guarantee is keyed entirely on the *caller* supplying the same
key twice; it offers zero protection against a caller that mints a fresh key
every time by construction. The retry would trigger a second real
`payment.execute` run — a second real payment — with ADR-0013 doing nothing
to stop it, because from durable-ledger's point of view the two triggers
never shared a key in the first place. This is exactly the risk
[ADR-0014](0014-customer-scoping-without-authentication.md)'s own
Consequences section flagged in advance: "if a future change wires
auto-approve into `SubmitIntent`... that same change MUST add a
client-supplied `Idempotency-Key` to `POST /intents` in the same change, or
a retried submission becomes a second real payment."

## Decision

### A caller-supplied `Idempotency-Key` derives `Intent.id` deterministically

`POST /intents` now accepts an optional `Idempotency-Key` header. When
present, `SubmitIntent` derives `Intent.id` as
`deriveIntentId(customerId, idempotencyKey)` — a hand-rolled RFC 4122 UUIDv5
(`app/derive-intent-id.ts`, SHA-1 over a fixed namespace UUID +
`${customerId}:${idempotencyKey}`) — instead of `randomUUID()`. A retried
`POST /intents` with the same `(customerId, idempotencyKey)` therefore
derives the *identical* `Intent.id` every time, which naturally dedups
against the existing `IntentAlreadyExistsError` path on `IntentRepository
.create()` (see `submit-intent.ts`'s own header, "Idempotent submission",
for the two-place check this requires — a pre-check for the ordinary
sequential-retry case, a catch around `create()` for the concurrent-race
case). Because that same `Intent.id` is what `AutoApproveIntent` then
supplies to `AgentCoreClient.startPaymentWorkflow` as its
`idempotencyKey`, a retried submission that reaches auto-approve twice
reuses the exact same ADR-0013 dedup key both times — closing the gap
described in Context without `SubmitIntent` needing to know anything about
durable-ledger, and without `AutoApproveIntent` needing any idempotency
logic of its own beyond "pass `intent.id` through."

**Why this mechanism, over a separate `idempotency_key` column.** The
alternative considered was keeping `Intent.id` random and adding a new
`idempotency_key` column (with a unique index on `(customer_id,
idempotency_key)`) to detect a retry, plus deriving a separate OUTBOUND key
of `<customerId>:<idempotencyKey>` to send to durable-ledger as the ADR-0013
trigger key. This was rejected for two reasons:

1. **No schema change.** The deterministic-id approach needs no new column,
   no new index, no migration — `Intent.id` already is the unique key
   `IntentRepository.create()` enforces.
2. **It is the only variant that survives a crash BETWEEN the
   durable-ledger trigger and the local confirm-write.** This is the
   decisive reason, not merely a tie-breaker. Consider the failure this
   package already accepts for `ApproveIntent` (see `README.md`'s
   `ApproveIntent` section, "the dud handle case"): the process crashes
   after `AgentCoreClient.startPaymentWorkflow` returns but before
   `AutoApproveIntent`'s confirming `repo.update()` lands. A client retry
   of `POST /intents` must re-derive the exact same durable-ledger dedup
   key on the second attempt, or the retry becomes a second real trigger.
   With a **random** `Intent.id` and a separate key column: the pre-check
   (`findById` on the derived lookup) would find the existing row by its
   `idempotency_key` column and short-circuit before ever re-deriving an
   outbound key — so this actually would work, **provided** the outbound
   key sent to durable-ledger is *also* derived from the caller's key
   (`<customerId>:<idempotencyKey>`), not from the random `Intent.id`. But
   at that point the `idempotency_key` column is redundant with `Intent.id`
   itself: both now exist solely to let two different code paths
   (`IntentRepository.create()`'s own uniqueness check, and the
   durable-ledger trigger) re-derive the same caller-supplied value. Making
   `Intent.id` itself that deterministic value removes the redundancy
   outright, with the schema and the ADR-0013 trigger key never able to
   drift apart, because they're now the same string.

**The real cost, stated honestly: intent ids become predictable.** Anyone
who knows `(customerId, idempotencyKey)` can compute `Intent.id` without
ever querying this service. This is a genuine property change worth
recording — but it is **not a new property** under this package's existing
security model. [ADR-0014](0014-customer-scoping-without-authentication.md)
already treats `X-Customer-Id` as a bare, unsigned, trivially-spoofable
header, and the ownership check comparing it against the stored
`Intent.customerId` is the only real access-control gate either way,
regardless of whether `Intent.id` is predictable or random — an attacker
who can forge `X-Customer-Id` already had no need to guess an id at all. A
smaller, genuinely new cost: the caller's actual `idempotencyKey` string is
not recoverable from the stored row — only *verifiable*, by recomputing
`deriveIntentId` and comparing. This is a minor audit-fidelity loss (an
operator reading the `agent.intents` table cannot recover which key a given
row was submitted with, only confirm a guess), accepted as the price of not
storing caller-supplied text unnecessarily.

### `Idempotency-Key` is optional, not required

Making it required would be a breaking change to `POST /intents`, which
already shipped and already has callers that don't send it. Instead,
auto-approve simply never fires on an unkeyed submission — see Consequences.
This is safe-by-default: it is the exact status quo `Intent.autoApprove`
was in before this feature existed (an `allow` verdict parks at `proposed`
forever), for any caller that doesn't opt in.

### Same-key-with-different-text is a conflict, not a replay

If a stored intent already exists for `(customerId, idempotencyKey)` but its
`text` differs from the retried request's `text`, `SubmitIntent` throws
`IdempotencyConflictError` (mapped to `409 idempotency_conflict` by
`server-error-mapper.ts`), rather than silently returning the earlier
intent's result. This matches `@apo/pay-core`'s own established
`idempotency_conflict` convention
(`packages/pay-core/src/adapters/http/error-mapper.ts`: an
`IdempotencyConflictError` also maps to `409 idempotency_conflict` there),
keeping the meaning of that code consistent across every HTTP surface in
this monorepo. It deliberately does **not** follow durable-ledger's own
ADR-0013 behavior, where a same-key retry with a genuinely different body is
silently discarded rather than flagged — ADR-0013 itself documents that as
an *accepted weakness* of `POST /workflows/payment` ("A same-key retry with
a genuinely different body is not detected as a conflict; it is simply
discarded"), not a pattern worth imitating one layer up. This package has
the information to detect the mismatch cheaply (`text` is already the one
field the pre-check reads), so it does.

## Consequences

- **`Intent.autoApprove` finally has a production caller.** A `proposed`
  intent whose original policy pass was `allow`, submitted with an
  `Idempotency-Key`, can now reach `executing` on the very first `POST
  /intents` call — `AutoApproveIntent` (`app/auto-approve-intent.ts`)
  re-evaluates policy fresh (not reusing `SubmitIntent`'s original verdict —
  same time-dependence reasoning `apply-policy.ts` already documents) and,
  if still `allow`, triggers durable-ledger with `idempotencyKey: intent.id`
  and confirms the `executing` transition.
- **Unkeyed submissions still never auto-approve — permanently, by design,
  not a TODO.** A caller that does not supply `Idempotency-Key` gets exactly
  the pre-existing behavior: an `allow` verdict on `POST /intents` parks the
  intent at `proposed` forever, with no route to `executing` except the
  human-approval path. This is not a gap to close in a later slice; it is
  the mechanism's load-bearing safety property — the client must opt in to
  auto-approve by supplying a key, because without one there is no dedup
  key to give durable-ledger and no safe way to retry.
- **A latency-profile change, not a spec violation.** On the `allow` +
  keyed path, `POST /intents` now makes two outbound calls instead of zero
  before returning — the LLM `reason()` call `SubmitIntent` already made,
  plus `AutoApproveIntent`'s `AgentCoreClient.startPaymentWorkflow` trigger
  call, both now inside the same request/response cycle. Spec §7's own
  constraint on `POST /intents` — reflected in this package's existing
  `getRunStatus`/no-`waitForCompletion` design (see `README.md`'s
  `AgentCoreClient` section) — forbids *waiting for the workflow to
  finish*, not triggering it: `startPaymentWorkflow` is a single, bounded
  HTTP call to durable-ledger's own trigger endpoint (itself non-blocking,
  per durable-ledger's own design), not a wait on the workflow's actual
  completion. This is therefore not a spec violation, only a real,
  worth-documenting change in how long a keyed, `allow`-bound `POST
  /intents` call now takes end-to-end.
- **The ADR-0013 "dud handle" residual risk is inherited unchanged.** If
  this process crashes between `AgentCoreClient.startPaymentWorkflow`
  returning and `AutoApproveIntent`'s confirming `repo.update()` landing, a
  client retry of `POST /intents` re-derives the same `Intent.id`, replays
  through `SubmitIntent`'s pre-check, and reaches `AutoApproveIntent` again
  — which re-sends the same `idempotencyKey` to durable-ledger and, per
  ADR-0013, gets back a *different*, permanently-`queued` `eventId` that it
  then persists. The real payment still ran exactly once; the stored
  `durableLedgerEventId` on the intent can end up pointing at a dud instead
  of it. This is the identical risk shape `README.md`'s `ApproveIntent`
  section already documents and accepts for the human-approval path — see
  that section rather than re-litigating it here. It is not new, not made
  worse, and not fixed by this change.
- **Predictable intent ids for anyone who knows `(customerId,
  idempotencyKey)`**, and **the caller's own key string is not recoverable
  from a stored row, only verifiable** — both discussed in full under
  Decision above.
- **A *concurrent* duplicate submit shares one downstream dedup key, and
  exactly-once here is not a local guarantee.** Two SIMULTANEOUS `POST
  /intents` calls carrying the same `(customerId, idempotencyKey)` can both
  observe the row at `proposed` before either call's own write lands — the
  local `SubmitIntent` pre-check (`findById` before `create()`) and
  `AutoApproveIntent`'s own `executing` short-circuit each only catch an
  intent whose OWN prior write has already committed; neither arbitrates two
  callers racing against the SAME still-`proposed` row. Both callers can
  therefore reach `AutoApproveIntent.execute()`, and both issue a
  `startPaymentWorkflow` call carrying the identical `idempotencyKey:
  intent.id`. Exactly-once still holds in the end, but ONLY because of
  `durable-ledger`'s own downstream Inngest dedup (ADR-0013) — not because
  of anything local to this feature — and that downstream guarantee is
  itself bounded by Inngest's event-retention window, not an unconditional
  one (ADR-0013's own documented caveat). The loser of the race gets a
  version conflict on its own confirming write → `ExecutionRaceLostError` →
  `409 execution_race_lost`. This is an accepted, legitimate design — the
  identical shape `ApproveIntent` already ships with for two concurrent
  `POST /intents/:id/approve` calls — not a new risk this ADR introduces,
  only one this ADR's own mechanism inherits and had not, until now, stated
  plainly.
