---
name: drizzle-shared-database-migrations
description: Two packages migrating into ONE Postgres database silently skip each other's migrations unless each sets its own migrationsSchema/migrationsTable — verified in drizzle-orm 0.45.2's source.
metadata:
  type: project
---

Verified 2026-09-11 by reading
`node_modules/.pnpm/drizzle-orm@0.45.2_*/node_modules/drizzle-orm/pg-core/dialect.js`
(the `migrate` implementation) while planning `packages/durable-ledger`'s
schema step.

**Every package that runs `drizzle-orm`'s `migrate()` against the shared `apo`
/ `apo_test` database MUST pass its own `migrationsSchema` (or
`migrationsTable`). The default is `drizzle.__drizzle_migrations` for
everybody.**
**Why:** `migrate()` reads only the single most recent row
(`order by created_at desc limit 1`) and then applies a migration only if
`Number(lastDbMigration.created_at) < migration.folderMillis`. `folderMillis`
is the wall-clock timestamp baked in at `drizzle-kit generate` time. So if
package B (generated later) migrates first into a fresh database, package A's
next `migrate()` sees B's larger timestamp as "the last applied migration" and
applies *nothing* — no error, no warning, A's tables simply never get created.
The failure looks like a broken app, not a broken migration.
**How to apply:** `packages/pay-core` already owns the default
`drizzle.__drizzle_migrations` (its migration is applied in CI/dev today), so
it must not be changed. Any new package points its own `migrate()` at a
distinct schema — e.g. `migrationsSchema: "ledger"` — and mirrors the same
value in `drizzle.config.ts`'s `migrations: { schema, table }` so
`drizzle-kit` agrees with the runtime migrator. See
[[pay-core-persistence-decisions]] for the rest of the driver/transaction
choices these adapters share.

Related: the spec (`docs/todo/02-durable-ledger.md` §7) says "same Postgres,
separate schema or prefix". A separate *Postgres schema* (`pgSchema("ledger")`)
satisfies that AND fixes the journal collision in one move, which a bare table
prefix does not.
