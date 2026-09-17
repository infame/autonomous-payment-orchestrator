import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AgentProposal } from "../../../domain/agent-proposal.js";
import type { PolicyVerdict } from "../../../policy/verdict.js";

/**
 * Drizzle schema for the `agent-orchestrator` Postgres adapter — one table,
 * `agent.intents`, the `Intent` aggregate (`src/domain/intent.ts`) round-trips
 * through.
 *
 * ## Its own Postgres *schema*, not just a table prefix
 *
 * This package shares one Postgres instance with `pay-core` (`public`
 * schema) and `durable-ledger` (`ledger` schema) — see `docker-compose.yml`.
 * `agent.intents` is the THIRD schema in that shared database, for the same
 * two reasons `durable-ledger`'s `schema.ts` gives for `ledger`:
 *  1. Namespace isolation — `intents` can never collide with, or be confused
 *     for, a `public` or `ledger` table when any package introspects the
 *     shared instance.
 *  2. Migration-journal isolation — drizzle-kit's default migration journal
 *     table lives in one place shared across the whole database, not scoped
 *     per schema. `migrator.ts` passes `migrationsSchema: "agent"` so this
 *     package's journal lives at `agent.__drizzle_migrations`, entirely
 *     separate from the other two packages' — applying one package's
 *     migrations never marks another's as applied or skips them.
 *
 * ## DB-level CHECKs vs. application-level invariants
 *
 * Every `check()` below mirrors a single-row invariant `Intent`/
 * `agent-proposal.ts` already enforce in memory — a second line of defense,
 * not the primary one. Cross-row invariants (e.g. "a customer has at most N
 * completed intents in 24h") stay entirely application-level
 * (`IntentRepository.countCompletedSince` + a future use-case's policy
 * check) — a `CHECK` constraint only ever sees the one row being
 * written/updated, so it cannot express a cross-row rule.
 *
 * ## `$type<...>()` is compile-time only
 *
 * `proposal`/`policyVerdict` are typed via `$type<AgentProposal>()` /
 * `$type<PolicyVerdict>()` purely for ergonomics at the call site — drizzle
 * does NOT validate the JSON shape at runtime. `mappers.ts`'s
 * `parseProposal`/`parsePolicyVerdict` are what actually validate a row read
 * back from storage; never trust the type parameter alone.
 */
export const agentSchema = pgSchema("agent");

export const intents = agentSchema.table(
  "intents",
  {
    id: uuid("id").primaryKey(),
    customerId: text("customer_id").notNull(),
    intentText: text("intent_text").notNull(),
    status: text("status").notNull(),
    proposal: jsonb("proposal").$type<AgentProposal>(),
    policyVerdict: jsonb("policy_verdict").$type<PolicyVerdict>(),
    durableLedgerEventId: text("durable_ledger_event_id"),
    clarificationAnswer: text("clarification_answer"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "intents_status_valid",
      sql`${t.status} IN ('received','needs_clarification','proposed','needs_approval','rejected','executing','completed','failed','needs_review')`,
    ),
    check("intents_version_positive", sql`${t.version} > 0`),
    // Same shape as `domain/intent.ts`'s `CUSTOMER_ID` validator.
    check(
      "intents_customer_id_format",
      sql`${t.customerId} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    // Same bound as `domain/intent.ts`'s `MAX_INTENT_TEXT_LENGTH` (10,000).
    check(
      "intents_text_bounded",
      sql`length(btrim(${t.intentText})) BETWEEN 1 AND 10000`,
    ),
    check(
      "intents_executing_requires_event_id",
      sql`${t.status} NOT IN ('executing','completed','failed','needs_review') OR ${t.durableLedgerEventId} IS NOT NULL`,
    ),
    // (a) A SQL CHECK predicate that evaluates to NULL (as `btrim(NULL)`
    // does) passes — Postgres only fails a row on FALSE, not NULL/UNKNOWN.
    // So this check only ever fires when `clarification_answer` IS present:
    // it enforces "non-blank when present", exactly mirroring
    // `intents_text_bounded` above, but never rejects a NULL (unanswered)
    // row. Same bound as `domain/intent.ts`'s `MAX_CLARIFICATION_ANSWER_LENGTH`
    // (2,000).
    check(
      "intents_clarification_answer_bounded",
      sql`length(btrim(${t.clarificationAnswer})) BETWEEN 1 AND 2000`,
    ),
    // (b) An answer can never be persisted while the row is still
    // `received`/`needs_clarification` — this is the DB-side mirror of
    // `AnswerClarification`'s single-write shape (record the answer on the
    // in-memory aggregate, transition it, THEN write once; never a two-write
    // "persist the answer, then later persist the transition" shape that
    // could leave a row with an answer but no resolved status).
    check(
      "intents_clarification_answer_requires_resolution",
      sql`${t.clarificationAnswer} IS NULL OR ${t.status} NOT IN ('received','needs_clarification')`,
    ),
    // (c) No set-once trigger on this column, unlike
    // `durable_ledger_event_id`'s (see `drizzle/0000_*.sql`'s hand-written
    // trigger): that trigger guards an exactly-once EXTERNAL side effect — a
    // duplicate `durable-ledger` workflow run is real money moved twice.
    // `clarification_answer` is an audit-fidelity concern, not an
    // exactly-once external effect, and it's already fully prevented by two
    // layers that exist regardless of this column: the status machine (no
    // transition ever re-enters `needs_clarification`, so there is no path
    // back to a state where a second answer could even be attempted) plus
    // the domain's own "already set" guard in
    // `Intent.recordClarificationAnswer`. A second DB-level enforcement
    // mechanism would be redundant, not defense-in-depth.
    index("intents_customer_status_updated_at_idx").on(
      t.customerId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export type IntentRow = typeof intents.$inferSelect;
export type NewIntentRow = typeof intents.$inferInsert;
