---
name: agent-orchestrator-persistence-decisions
description: Why agent-orchestrator's IntentRepository carries `version` explicitly instead of copying pay-core's WeakMap, which Postgres schema it owns, and the two gaps spec §8's column list leaves open.
metadata:
  type: project
---

Decided 2026-09-16 while planning spec step 5 of
`docs/todo/03-agent-orchestrator.md` (`IntentRepository` + Postgres/in-memory
adapters).

**Optimistic-lock `version` stays out of the `Intent` aggregate and is carried
explicitly by the port (`StoredIntent { intent, version }`; `update(intent,
expectedVersion)`), NOT by pay-core's `WeakMap<Payment, number>` trick.**
**Why:** the WeakMap in `PgPaymentRepository` is a workaround for a port
signature that was already frozen and had nowhere to put a version — see
[[pay-core-persistence-decisions]]. `IntentRepository` is a fresh port, so the
version can be a parameter, and then the in-memory adapter can implement the
*same* conflict semantics (pay-core's in-memory one can't, and silently
doesn't). Instance-identity-keyed state also can't survive a round trip
through a use-case that re-loads.
**How to apply:** don't "harmonise" this with pay-core later; the divergence
is the point. If a second aggregate ever needs the same treatment in this
package, follow `IntentRepository`, not `PaymentRepository`.

**This package owns the `agent` Postgres schema (`pgSchema("agent")`,
`agent.intents`, `migrationsSchema: "agent"`).** `pay-core` = `public` +
default journal, `durable-ledger` = `ledger`. See
[[drizzle-shared-database-migrations]] for why the journal isolation is
load-bearing and not cosmetic.

**Spec §8's `intents` column list had two known gaps. Gap (1) is CLOSED by
the `AnswerClarification` slice (planned 2026-09-16); gap (2) was closed at
step 5 by `countCompletedSince`.**
**Why:** (1) there was no `clarification_answer` column and no such field on
`IntentProps`, yet `PolicyContext.clarificationAnswer` (`policy/evaluate-policy.ts`)
feeds the `amount-must-be-grounded` check — so a proposal grounded in the
user's *answer* was not reproducible from storage, breaking spec §1's audit
requirement. Resolution: nullable `clarification_answer text` +
`IntentProps.clarificationAnswer` + a set-once domain recorder.
(2) `daily-rate-limit` needs a count of `completed` intents per customer in
24h, which has to be a repository query (`countCompletedSince`), keyed on
`updated_at`, not `created_at` — a terminal intent never updates again, so
`updated_at` IS the completion time.
**How to apply:** the two new CHECKs are
`intents_clarification_answer_bounded` (btrim length 1..2000) and
`intents_clarification_answer_requires_resolution`
(`answer IS NULL OR status NOT IN ('received','needs_clarification')`) — the
second one encodes "only one round of clarification" at the DB level and
therefore *forbids* a persist-the-answer-then-call-the-LLM (two-write) shape.
If a slice ever needs to resume a half-answered intent, that CHECK must be
relaxed first. No set-once trigger for this column (unlike
`durable_ledger_event_id`): a rewritten answer is an audit-fidelity concern,
not a second irreversible external side effect, and the status machine
already prevents it.

**`PgIntentRepository.update()` writes an explicit `.set({...})` allow-list,
not the whole row.** Every NEW mutable column must be added there by hand or
it silently never persists on update (immutable ones — `customer_id`,
`intent_text`, `created_at` — are correctly absent). Cover each new mutable
column with a `pg-intent-repository.integration.test.ts` update-round-trip
assertion; the in-memory adapter can't catch this class of bug because it
`structuredClone`s the whole `IntentProps`.

**A "claim before calling durable-ledger" step is UNIMPLEMENTABLE. (The
stale-header half of this note is CLOSED: re-verified 2026-09-19, all four
sites — `ports/intent-repository.ts`, `ports/agent-core-client.ts`,
`README.md`, `domain/intent.ts` — now describe ADR-0013 correctly. Do not
"fix" them again.)**
**Why:** a claim would have to write `status = 'executing'`, but both
`Intent.approve`/`autoApprove` and the DB CHECK
`intents_executing_requires_event_id` require a `durableLedgerEventId` that
only durable-ledger can mint. So the order is forced: call first, then ONE
conditional `update(intent, expectedVersion)` setting status+eventId
together — which is what spec §6 literally asks for anyway. A claim column
(`execution_claim_id`) would close the concurrent-double-approve case but
fails CLOSED and unrecoverably: with no eventId there is no way to ask
durable-ledger whether the run exists (lookup is by server-assigned event id
only).
**How to apply:** a claim column (`execution_claim_id`) stays rejected for
the reason above. See [[agent-orchestrator-auto-approve-design]] for why the
auto-approve path solves the retried-`POST /intents` case with a
deterministic `Intent.id` instead — no new column, no migration.

**ADR-0013 (2026-09-17) closed the MONEY half of §6's hole and converted the
residual into an OBSERVABILITY one. Do not describe it as still open.**
**Why:** with a deterministic `idempotencyKey = Intent.id` on the trigger,
every retry after a crash/timeout between the call and the write reuses the
same key, so Inngest creates at most one `payment.execute` run per intent —
regardless of whether our own write ever happened. What replaces it: the
retry gets back a *fresh, dud* eventId that will never have a run
([[inngest-event-dedup-behavior]]), and the real run's eventId was lost with
the crashed frame. Nothing can recover it — `GET /v1/events` has no `id`
filter and durable-ledger exposes lookup by server-assigned eventId only, so
a key cannot be resolved back to its event. So the intent can end up
`executing` behind a handle that reads `queued` forever.
**How to apply:** state the guarantee as "at most one workflow run per
intent, always; a correct *handle* to that run in every case except a crash
inside the call→write window". A stuck-`queued` handle is the documented
reconciliation signal (ADR-0013 Consequences), not a reason to poll harder.
Closing the handle half needs the `workflow_runs` table ADR-0010/0013
pre-authorized, and that is the ONLY thing that would close it.
