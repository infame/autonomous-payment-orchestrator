---
name: pay-core-persistence-decisions
description: Why the pay-core Postgres adapters need an AsyncLocalStorage transaction scope, and the driver/locking choices behind it — the port signatures make the obvious designs wrong.
metadata:
  type: project
---

Design decisions for the Postgres/Drizzle adapters in `packages/pay-core`
(planned 2026-09-04 on branch `feat/postgres-adapters`).

**The binding constraint:** `PaymentRepository.save()` and
`IdempotencyStore.save()` take no transaction/connection argument, and the
use-cases call them as two separate `await`s. The spec's "exactly once"
guarantee requires both writes in ONE transaction, so *something outside the
use-case* must own the transaction boundary without changing the ports.

**Why:** if the payment mutation commits and only the idempotency INSERT hits
the UNIQUE violation, the duplicate request has already double-captured. The
unique constraint only buys exactly-once if the losing transaction rolls the
payment mutation back with it.

**How to apply:**
- A shared mutable "current transaction" field on a singleton adapter is a
  *correctness bug*, not a style issue: concurrent requests interleave on the
  same adapter instance and would leak each other's transaction. Use
  `AsyncLocalStorage`. This also matters for the concurrency integration tests,
  which fire parallel requests in one process.
- Begin the transaction **lazily on first write**, not at the start of the
  scope, so no pooled connection is held across the PaymentProvider call.
- Driver: `pg` (node-postgres) over postgres.js, specifically because a
  wrapper-committed lazy transaction needs manual `connect`/`BEGIN`/`COMMIT`;
  postgres.js only offers callback-scoped `sql.begin`.
- Optimistic locking: the domain has no `version` field by design, so the
  adapter must remember the loaded version per *aggregate instance*
  (`WeakMap<Payment, number>`), never a `Map` keyed by payment id — a shared id
  map silently re-arms a stale writer and loses updates.
- The explicit alternative (a `UnitOfWork` port passed into the use-cases) is
  more honest but touches the ports + all three mutating use-cases; it was
  raised to the coordinator rather than decided unilaterally.

See [[pay-core-spec-vs-code]] for where the spec's table definitions are
incomplete.
