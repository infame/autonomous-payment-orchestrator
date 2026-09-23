import {
  check,
  date,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema for `orchestra`'s own Postgres adapter — grant state ONLY,
 * no money table. This package shares one Postgres instance with `pay-core`
 * (`public`), `durable-ledger` (`ledger`), and `agent-orchestrator`
 * (`agent`) — see `docker-compose.yml`. `orchestra` is the FOURTH schema in
 * that shared database, for the same two reasons `agent-orchestrator`'s
 * `schema.ts` and `durable-ledger`'s give for their own:
 *  1. Namespace isolation — `live_grants`/`live_budget` can never collide
 *     with a `public`/`ledger`/`agent` table.
 *  2. Migration-journal isolation — `migrator.ts` passes
 *     `migrationsSchema: "orchestra"`, so this package's journal lives at
 *     `orchestra.__drizzle_migrations`, entirely separate from the other
 *     three packages'. Sharing one migrations table across packages is
 *     SILENT — no error, just skipped migrations — see `migrator.ts`'s own
 *     header and `docs/todo/05-orchestra.md §4`'s "CRITICAL" callout.
 */
export const orchestraSchema = pgSchema("orchestra");

export const liveGrants = orchestraSchema.table(
  "live_grants",
  {
    jti: uuid("jti").primaryKey(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    maxCalls: integer("max_calls").notNull(),
    usedCalls: integer("used_calls").notNull().default(0),
    boundSessionId: text("bound_session_id"),
  },
  (t) => [
    check("live_grants_max_calls_positive", sql`${t.maxCalls} > 0`),
    check("live_grants_used_calls_non_negative", sql`${t.usedCalls} >= 0`),
    check("live_grants_used_within_max", sql`${t.usedCalls} <= ${t.maxCalls}`),
    check(
      "live_grants_expires_after_issued",
      sql`${t.expiresAt} > ${t.issuedAt}`,
    ),
  ],
);

export type LiveGrantRow = typeof liveGrants.$inferSelect;
export type NewLiveGrantRow = typeof liveGrants.$inferInsert;

/** Global backstop, independent of any single grant — one row per UTC day (`day` as `YYYY-MM-DD`). */
export const liveBudget = orchestraSchema.table(
  "live_budget",
  {
    day: date("day", { mode: "string" }).primaryKey(),
    usedCalls: integer("used_calls").notNull().default(0),
  },
  (t) => [
    check("live_budget_used_calls_non_negative", sql`${t.usedCalls} >= 0`),
  ],
);

export type LiveBudgetRow = typeof liveBudget.$inferSelect;
