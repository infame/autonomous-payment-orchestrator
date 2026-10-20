import {
  bigint,
  check,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema for the durable-ledger Postgres adapter — one table,
 * `ledger.ledger_entries`, the append-only append log `LedgerEntry` /
 * `PostingGroup` (`src/domain/entry.ts`) round-trip through.
 *
 * ## Its own Postgres *schema*, not just a table prefix
 *
 * Spec §7: this package shares one Postgres instance with `pay-core` (see
 * `docker-compose.yml`), but its tables live in their own `ledger` schema
 * (`pgSchema("ledger")` below), not `public`. Two independent reasons, both
 * load-bearing:
 *  1. Namespace isolation — `ledger_entries` can never collide with, or be
 *     confused for, one of pay-core's `public` tables when either package
 *     introspects the shared database.
 *  2. Migration-journal isolation (the non-obvious one) — drizzle-kit
 *     tracks applied migrations in a journal table (default
 *     `drizzle.__drizzle_migrations`) that, by default, is shared across the
 *     *entire* database, not scoped per schema/package. Two packages
 *     generating and applying migrations independently against the same
 *     Postgres instance would silently share (and corrupt) one journal.
 *     `migrator.ts` passes `migrationsSchema: "ledger"` to drizzle's
 *     `migrate()` so this package's journal lives at
 *     `ledger.__drizzle_migrations`, entirely separate from pay-core's
 *     default-schema journal — applying one package's migrations never
 *     marks the other's as applied or skips them.
 *
 * ## `currency` is its own column
 *
 * `LedgerEntryProps` does NOT gain a `currency` field — `Money` is a value
 * object whose serialized form is the pair `amount`+`currency`, exactly
 * like pay-core's `payments.amount_authorized`/`payments.currency` split
 * (`packages/pay-core/src/adapters/persistence/drizzle/schema.ts`).
 * Rehydrate with `Money.of(row.amount, row.currency)`.
 *
 * ## `amount` is `bigint(..., { mode: "number" })`
 *
 * Same tradeoff as pay-core's `payments` table — see the comment above
 * `payments` in `packages/pay-core/src/adapters/persistence/drizzle/schema.ts`
 * for the full rationale (JS `number` precision ceiling vs. `Money.amount`
 * already being a plain `number` everywhere); not re-derived here.
 *
 * ## `payment_id` is `text`, not `uuid`, and has no foreign key
 *
 * It's an opaque id minted by pay-core, a *separate service* this package
 * only ever reaches over HTTP (spec §1) — even though, today, both
 * packages' tables happen to live in one Postgres instance, there is
 * deliberately no FK across that boundary (a real deployment would have two
 * databases). `PostingGroup.create` mirrors this: it validates `operationId`
 * (and `reversesOperationId`) as UUIDs but never validates `paymentId` as
 * one, because it isn't this package's format to police.
 *
 * ## `operation_id` / `reverses_operation_id` ARE `uuid`
 *
 * Unlike `payment_id`, these are minted and validated as UUIDs by the
 * domain (`assertUUID` in `entry.ts`), so the column type can enforce the
 * same shape the domain already guarantees.
 *
 * ## DB-level CHECKs vs. application-level invariants
 *
 * The `check()` constraints below are a *second line of defense* mirroring
 * `PostingGroup.create`'s single-row invariants only: positive amount,
 * valid `direction`/`entry_type` enum, valid `currency`/`account` format —
 * each one is a property of one row in isolation, so a `CHECK` can express
 * it. The CROSS-ROW invariants — sum(debit) == sum(credit) per
 * `operation_id`, at least two entries with at least one of each direction,
 * a single currency per group — stay entirely application-level in
 * `PostingGroup.create`, enforced *before* a single row is ever written.
 * A `CHECK` constraint only ever sees the one row being written/updated;
 * expressing a cross-row invariant in SQL would need a deferred constraint
 * trigger (checking all rows for an `operation_id` at commit time) or a
 * parent `posting_groups` row carrying the aggregate. Both are out of scope
 * for this step — flag as a future option if step 3's atomic multi-row
 * insert ever needs a DB-level backstop for it, but don't build it now: the
 * application-level check running inside the same transaction as the insert
 * is already a real guarantee, not just a best-effort one.
 *
 * ## Uniqueness: compound, not `UNIQUE(operation_id)`
 *
 * Spec §7 literally asks for `UNIQUE(operation_id)`, but that's impossible
 * to satisfy: a balanced posting group is *at least two* rows sharing one
 * `operation_id` by construction (`PostingGroup.create`'s "≥2 entries"
 * invariant). Only the compound `(operation_id, account, direction)` is
 * satisfiable — no two entries in the same group may already share both an
 * account and a direction, which `PostingGroup.create` also enforces
 * in-memory. This compound index's leading column is `operation_id`, so it
 * also serves as the "index on operation_id" §7 separately asks for; a
 * standalone index on just `operation_id` would be redundant and is
 * deliberately not added.
 *
 * ## The two other indexes
 *
 * `(account, currency)` is the access path `balances.ts`'s `balanceOf` /
 * `balanceSheet` projections need (find every entry for one account in one
 * currency). `payment_id` is the "every ledger entry for this payment"
 * lookup a future read API will use.
 */
export const ledgerSchema = pgSchema("ledger");

export const ledgerEntries = ledgerSchema.table(
  "ledger_entries",
  {
    id: uuid("id").primaryKey(),
    operationId: uuid("operation_id").notNull(),
    account: text("account").notNull(),
    direction: text("direction").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    paymentId: text("payment_id").notNull(),
    entryType: text("entry_type").notNull(),
    reversesOperationId: uuid("reverses_operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("ledger_entries_amount_positive", sql`${t.amount} > 0`),
    check(
      "ledger_entries_direction_valid",
      sql`${t.direction} IN ('debit','credit')`,
    ),
    check(
      "ledger_entries_entry_type_valid",
      sql`${t.entryType} IN ('capture','refund','reversal')`,
    ),
    check("ledger_entries_currency_iso4217", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "ledger_entries_account_format",
      sql`${t.account} = 'acquirer_clearing' OR ${t.account} ~ '^(customer|merchant):[A-Za-z0-9_-]{1,64}$'`,
    ),
    uniqueIndex("ledger_entries_operation_account_direction_uq").on(
      t.operationId,
      t.account,
      t.direction,
    ),
    index("ledger_entries_account_currency_idx").on(t.account, t.currency),
    index("ledger_entries_payment_id_idx").on(t.paymentId),
  ],
);

export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntryRow = typeof ledgerEntries.$inferInsert;

/** Best-effort sanitized observations; never the source of payment truth. */
export const executionAttempts = ledgerSchema.table(
  "execution_attempts",
  {
    id: uuid("id").primaryKey(),
    runId: text("run_id").notNull(),
    eventId: text("event_id"),
    step: text("step").notNull(),
    phase: text("phase").notNull(),
    paymentId: text("payment_id"),
    operationId: uuid("operation_id"),
    idempotencyKey: text("idempotency_key"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
  },
  (t) => [
    index("execution_attempts_run_started_idx").on(t.runId, t.startedAt),
    check(
      "execution_attempts_step_check",
      sql`${t.step} IN ('authorize','capture','post-ledger')`,
    ),
    check(
      "execution_attempts_phase_check",
      sql`${t.phase} IN ('workflow','resend')`,
    ),
    check(
      "execution_attempts_outcome_check",
      sql`${t.outcome} IN ('started','succeeded','failed')`,
    ),
  ],
);
