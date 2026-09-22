---
name: pay-core-spec-vs-code
description: docs/todo/01-pay-core.md is the local-only spec of record but explicitly defers to the code; its §4.1 table definitions are incomplete — check against PaymentProps before trusting them.
metadata:
  type: project
---

`docs/todo/01-pay-core.md` (Russian, v2) is the spec of record for
`packages/pay-core`, but it is **gitignored / local-only** and its own preamble
says the code is the source of truth and the doc follows it.

**Why:** the specs were written up-front for the portfolio monorepo and run
ahead of the code; the owner keeps them out of the public repo. So a mismatch
between doc and code is usually the doc being stale, not the code being wrong.

**How to apply:** when planning from §4.1 (the table column lists), diff them
against the actual domain types first. Known gaps found 2026-09-04:
- `payments` has no `failure_reason` column in the spec, but `PaymentProps` has
  `failureReason` — without it, rehydration silently drops data.
- Spec calls the column `state`; the aggregate calls it `status`.
- `payments.metadata` (jsonb) has no domain counterpart at all.
- `payment_events.id` (uuid pk) has no counterpart: `DomainEvent` carries no
  id, even though ADR-0003 claims "events carry a stable id so downstream can
  dedupe". Adding one is a domain change, not an adapter detail.
- `idempotency_keys` needs `operation` and `payment_id`, neither of which
  exists on the `IdempotencyRecord` port type.

Never edit the domain to fit the adapter — §13 of the spec ends with "if
something in the adapter pulls at the domain, the domain is designed wrong".
Raise the mismatch instead. See [[pay-core-persistence-decisions]].
