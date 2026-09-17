import { and, eq, gte, sql } from "drizzle-orm";
import { Intent } from "../../../domain/intent.js";
import {
  IntentAlreadyExistsError,
  IntentVersionConflictError,
  type IntentRepository,
  type StoredIntent,
} from "../../../ports/intent-repository.js";
import { intents } from "./schema.js";
import type { Database } from "./db.js";
import { isUniqueViolation } from "./errors.js";
import { intentToRow, rowToIntent } from "./mappers.js";

/**
 * Postgres/Drizzle implementation of `IntentRepository`.
 *
 * Concurrency: every mutation here is a single-statement, single-table
 * operation (unlike `@apo/pay-core`'s cross-port transaction needs), so the
 * constructor takes the `Database` directly — no transaction-scope /
 * AsyncLocalStorage machinery.
 *
 * `update()` persists whatever `updatedAt` is already on the domain
 * snapshot being written (via `intentToRow`) — it never invents its own
 * wall-clock timestamp. This matches `create()` (which also just writes
 * `intentToRow`'s `updatedAt` verbatim) and `InMemoryIntentRepository`
 * (which stores the domain snapshot's `updatedAt` as-is), so a caller can
 * rely on the returned/stored `updatedAt` being exactly the value the
 * domain transition (`Intent.complete(now)`, etc.) recorded — never a
 * silently-substituted server time.
 */
export class PgIntentRepository implements IntentRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<StoredIntent | null> {
    const rows = await this.db
      .select()
      .from(intents)
      .where(eq(intents.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { intent: rowToIntent(row), version: row.version };
  }

  async create(intent: Intent): Promise<StoredIntent> {
    try {
      const rows = await this.db
        .insert(intents)
        .values(intentToRow(intent, 1))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error(
          `PgIntentRepository.create: insert for intent "${intent.id}" returned no row`,
        );
      }
      return { intent: rowToIntent(row), version: row.version };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new IntentAlreadyExistsError(intent.id, { cause: err });
      }
      throw err;
    }
  }

  async update(intent: Intent, expectedVersion: number): Promise<StoredIntent> {
    const row = intentToRow(intent, expectedVersion + 1);
    const rows = await this.db
      .update(intents)
      .set({
        status: row.status,
        proposal: row.proposal,
        policyVerdict: row.policyVerdict,
        durableLedgerEventId: row.durableLedgerEventId,
        clarificationAnswer: row.clarificationAnswer,
        version: row.version,
        updatedAt: row.updatedAt,
      })
      .where(
        and(eq(intents.id, intent.id), eq(intents.version, expectedVersion)),
      )
      .returning();
    const updated = rows[0];
    // Nothing ever deletes a row, so zero rows on this UPDATE always means a
    // stale `expectedVersion` — never a missing intent.
    if (!updated) {
      throw new IntentVersionConflictError(intent.id, expectedVersion);
    }
    // Re-map the RETURNING row (mirroring create()) so the returned
    // aggregate is guaranteed to reflect exactly what's in the database,
    // never the caller's pre-write input object.
    return { intent: rowToIntent(updated), version: updated.version };
  }

  async countCompletedSince(customerId: string, since: Date): Promise<number> {
    // Predicate is on `updated_at`, not `created_at`, because `completed` is
    // a terminal status — `updated_at` on a completed row IS the completion
    // time.
    const rows = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(intents)
      .where(
        and(
          eq(intents.customerId, customerId),
          eq(intents.status, "completed"),
          gte(intents.updatedAt, since),
        ),
      );
    return Number(rows[0]?.n ?? "0");
  }
}
