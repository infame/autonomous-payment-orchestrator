---
name: durable-ledger-posting-constraints
description: Verified constraints behind durable-ledger's posting repository — why the unique index alone can't detect a bad re-post, why idempotency comparison must ignore row ids, and the int8/numeric gotchas.
metadata:
  type: project
---

Found 2026-09-11 while planning step 3 (`packages/durable-ledger`'s posting
repository) — each item verified against the running `postgres:17-alpine`
container or drizzle-orm 0.45.2's source, not inferred from docs.

**`UNIQUE (operation_id, account, direction)` cannot detect every duplicate
post.** Two groups sharing an `operationId` but touching *disjoint*
`(account, direction)` tuples (e.g. a caller bug where the merchant id
changed under a stable key) collide on nothing and both commit — 4 rows under
one operation id.
**Why:** the index only catches overlapping tuples, and the doubled ledger
still sums to zero, so `assertZeroSum`/`GET /ledger/integrity` never catches
it either. This failure mode is silent in *both* lines of defence.
**How to apply:** posting must read `WHERE operation_id = $1` inside the same
transaction as the insert, under `pg_advisory_xact_lock(hashtextextended(
operationId::text, 0))` (verified callable on PG17) so the read is
authoritative against a concurrent racer. The unique index then degrades to a
backstop. See [[durable-ledger-invariants]] for why the index is compound at
all.

**`PostingGroup.create` mints a fresh `randomUUID()` per entry on every
call.** A retried step rebuilding "the same" group gets different row `id`s
(and a different `createdAt` unless `now` is passed).
**Why:** it makes the obvious idempotency check — compare the new group's
entries to the stored ones — always report a mismatch.
**How to apply:** the sameness comparison must be over the identity-bearing
fields only: `(account, direction, amount, currency, paymentId, entryType,
reversesOperationId)`, canonically ordered. Never `id`, never `createdAt`.
An already-posted result must return the *stored* ids, not the caller's.

**`Money.of` accepts amounts outside `bigint` range** —
`Number.isInteger(2 ** 63) === true`, so the domain happily builds a balanced
group Postgres rejects with SQLSTATE 22003 ("bigint out of range", verified).
This is the one legitimate way to make a valid `PostingGroup` fail at the DB,
and the only non-contrived DB-rejection test available: steps 1+2 otherwise
make every per-row CHECK unreachable through the domain.

**`SUM(bigint)` returns `numeric`, which `pg` hands back as a *string*.**
Any SQL-side balance must parse via `BigInt(raw)` + an explicit
`Number.MAX_SAFE_INTEGER` range check before `Money.of` — `Number(raw)`
silently rounds past 2^53.

**drizzle-orm 0.45.2's `db.transaction()` rethrows the callback's error
unchanged** (`node-postgres/session.js`: catch → `rollback` → `throw error`).
So a typed conflict error thrown inside the callback reaches the caller
un-wrapped, while *query* errors are still wrapped in `DrizzleQueryError` —
which is why pay-core's `isUniqueViolation` has to unwrap `err.cause`.
