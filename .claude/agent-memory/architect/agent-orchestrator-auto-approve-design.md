---
name: agent-orchestrator-auto-approve-design
description: agent-orchestrator auto-approve path design — why spec §7 does NOT forbid a durable-ledger trigger inside POST /intents, the deterministic-UUIDv5-intent-id decision (no migration), the "persisted `proposed` means policy said allow" invariant, and the non-vacuity control test that makes the retry-safety test reviewable.
metadata:
  type: project
---

Designed 2026-09-19, planning the deferred "Auto-approve path" roadmap item
in `packages/agent-orchestrator/README.md`. Supersedes the "keep it OUT of
step 8" entry in [[agent-orchestrator-http-step8-decisions]] (that deferral
is now being cashed in, not extended).

**Spec §7's "`POST /intents` must not block" does NOT forbid the auto-approve
trigger — re-read the actual sentence before anyone relitigates this.**
**Why:** §7 says the route «**не блокируется до завершения**
`durable-ledger`-воркфлоу — возвращает текущий статус сразу после LLM+policy
шага (`proposed`/`needs_approval`/`rejected`/**`executing`**)». It forbids
waiting for the *workflow to finish*; it explicitly lists `executing` as a
legal immediate response status, which is only reachable if the trigger (a
202, not a completion) fires inside the request. §10 level 2 likewise
requires a "policy allow → executing → completed" happy path.
**How to apply:** do not flag a synchronous `startPaymentWorkflow` on the
allow path as a spec deviation. The real consequence to disclose is latency:
`POST /intents` on the allow path now makes two outbound calls (LLM, then
the durable-ledger trigger) and two `countCompletedSince` reads.

**A PERSISTED `proposed` status uniquely means "policy's last evaluation
returned `allow`" — verified 2026-09-19 against both writers.**
**Why:** `Intent.propose()` has exactly two callers (`SubmitIntent`,
`AnswerClarification`) and both call `applyPolicy` immediately afterwards,
before their single repository write; `applyPolicy` moves the intent off
`proposed` on `needs_approval`/`reject`. So `proposed` never reaches storage
with an unevaluated or non-allow verdict, even though the `allow` verdict
itself is deliberately not persisted
([[agent-orchestrator-use-case-decisions]]).
**How to apply:** this is what lets an auto-approve caller key off
`status === "proposed"` instead of a freshly-returned verdict — which is
what makes a retried `POST /intents` able to re-drive an intent whose first
trigger attempt failed. If a third caller of `propose()` ever appears
without an `applyPolicy` call behind it, this invariant dies and the
auto-approve route condition silently becomes wrong.

**The intent id itself becomes deterministic (`uuidv5(NS, customerId + ":" +
idempotencyKey)`) when a caller supplies `Idempotency-Key`; there is NO new
column and NO migration.**
**Why:** the PK is already the uniqueness constraint, `IntentAlreadyExists
Error` is already a real handled error on `create()`, and the outbound
durable-ledger key stays `intent.id` (one rule, shared with `ApproveIntent`).
Crucially it is the only variant that survives a crash *between* the
durable-ledger call and the `create()`/`update()` write: a separate
`idempotency_key` column with a random `intent.id` would mint a NEW id on the
retry and therefore a NEW ADR-0013 dedup key — a second real payment —
unless the outbound key were derived from the caller key anyway, at which
point the column is redundant. Customer scoping falls out for free: the id
is derived from the caller's own `X-Customer-Id`, so a caller can only ever
address ids inside its own namespace, and same-key/different-customer
produces two distinct intents (an ADR-0014 property worth its own test).
**How to apply:** it must be a real UUID**v5** (version+variant nibbles set),
not a raw hash — `IntentIdParam` is `z.string().uuid()` and `agent.intents.id`
is a `uuid` column. Hand-roll it over `node:crypto`'s sha1 (~12 lines, no new
dependency) and pin it with the RFC 4122 vector
`uuidv5(6ba7b810-9dad-11d1-80b4-00c04fd430c8, "www.example.org") =
74738ff5-5367-5958-9aee-98fffdcd1876`, not just a self-consistency assertion.
The separator is unambiguous because `CUSTOMER_ID_PATTERN` is
`[A-Za-z0-9_-]` and therefore cannot contain `:`.

**`IntentAlreadyExistsError` must KEEP mapping to 500 in
`server-error-mapper.ts`.** It becomes a normal replay signal only on the
keyed `SubmitIntent` path, where the use-case catches it itself; reaching the
mapper still means a `randomUUID()` collision, i.e. a genuine server fault.
Do not "fix" the mapper.

**The retry-safety test is only reviewable if it ships with a control that
produces TWO runs.** This package's review history keeps catching vacuous
ordering/idempotency tests. `FakeAgentCoreClient` already exposes
`realRunCount` and `realRunEventIdFor(key)`, so assert `realRunCount === 1`
AND `calls.length === 1` for the same-key pair, and put a sibling test with
*different* keys (and one with the same key but different `X-Customer-Id`)
asserting `realRunCount === 2` right next to it. Without that control, a
harness that can never register a second run would pass the important test
for the wrong reason.
