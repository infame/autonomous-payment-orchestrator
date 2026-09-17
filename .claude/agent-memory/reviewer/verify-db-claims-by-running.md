---
name: verify-db-claims-by-running
description: Postgres is usually already up on localhost:5433 here, so `pnpm --filter <pkg> test:integration` runs during review — use it (plus a raw-SQL probe) to check adapter and CHECK-constraint claims instead of trusting test comments.
metadata:
  type: project
---

Integration suites in this repo are runnable from a review session: the
compose Postgres is typically already listening on `localhost:5433`, and each
package's `test:integration` script defaults `TEST_DATABASE_URL` to
`.../apo_test` and applies its own migrations via vitest `globalSetup`.

Probe recipe that works: write `probe.mts` in the scratchpad, run it with
`npx tsx <scratchpad>/probe.mts` **from the package dir**, import repo modules
by *absolute* path, and do independent verification with raw `pool.query(...)`.
Details that cost a round-trip each time:

- `drizzle/db.ts` exports `createPool(url)` / `createDb(pool)`, **not** a
  ready-made `pool` — build it: `const pool = createPool("postgres://apo:apo@localhost:5433/apo_test")`.
- Do NOT `import` a third-party package (`drizzle-orm`, `pg`) at the top of a
  scratchpad file — Node resolves it relative to the scratchpad and fails with
  ERR_MODULE_NOT_FOUND; only the repo-file imports resolve.
- Use `.mts`, not `.ts` (top-level await). `npx tsx -e` also fails on
  top-level await — always use a file.
- `agent.intents.id` is a real `uuid` column (use `crypto.randomUUID()`), and
  the intent body column is `intent_text`, not `text`.

**Why:** on `feat/agent-orchestrator-intent-repository` (2026-09-16) a
Postgres adapter's `update()` returned the caller's own aggregate instead of
re-mapping the `RETURNING` row, so the returned `updatedAt` was the
caller-supplied domain timestamp while the row stored `new Date()`. Every test
passed, and the integration test's own comment claimed it asserted the stored
value. A 15-line probe showed a six-year divergence. (Fixed in a46fda0:
`update()` now does a full `.returning()` and returns `rowToIntent(updated)`.)

**How to apply:** when a diff adds or changes a persistence adapter, run its
integration suite, and separately probe any claim of the form "the returned
object equals what was stored" or "this test proves the boundary is
inclusive". Checks that keep paying off:

1. Does each mutating method map its `.returning()` row back through the
   mapper, or does it hand back the input aggregate? Compare against
   `pay-core`'s `PgPaymentRepository.save`, the established precedent.
2. For a "boundary is inclusive" test, run the *same dataset* through raw SQL
   with `>=` and with `>`. If both give the asserted number, the test is not
   load-bearing. (Here: `>=` -> 2, `>` -> 1, so it is.)
3. `agent-orchestrator` adds CHECK constraints whose stated job is to forbid a
   *shape* ("never a two-write persist-then-transition"). Its schema tests only
   exercise INSERT; the claim is about UPDATE. Probe the UPDATE path directly,
   and `select conname, pg_get_constraintdef(oid) from pg_constraint` /
   `pg_get_triggerdef` to confirm what actually landed — a migration's hand-
   written triggers are invisible to drizzle-kit snapshots.
4. Hand-written `.set({...})` allow-lists in `update()` silently drop new
   columns. The guarding test must create, mutate the new field, update, and
   then **re-read** — an assertion on the returned aggregate alone only works
   because `update()` re-maps `RETURNING` (check that it still does).

See [[project-docs-aspirational]] for why doc and spec claims also need
checking against code.
