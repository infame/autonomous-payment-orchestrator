import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { Grant } from "../../../domain/grant.js";
import type {
  CreateGrantInput,
  GrantStore,
  LiveBudgetStore,
} from "../../../ports/grant-store.js";
import { liveBudget, liveGrants } from "./schema.js";
import type { Database } from "./db.js";
import { rowToGrant } from "./mappers.js";

/**
 * Postgres/Drizzle implementation of `GrantStore`. Every mutating method is
 * a single `UPDATE ... WHERE ... RETURNING` (or, for `create`, a single
 * `INSERT ... RETURNING`) — no read-then-decide-then-write pair anywhere in
 * this class. See `ports/grant-store.ts`'s header for why that matters
 * (ADR-0019 precedent) and `docs/todo/05-orchestra.md §4` for the exact SQL
 * shape each method below compiles to.
 */
export class PgGrantStore implements GrantStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateGrantInput): Promise<Grant> {
    const rows = await this.db
      .insert(liveGrants)
      .values({
        jti: input.jti,
        expiresAt: input.expiresAt,
        maxCalls: input.maxCalls,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(
        `PgGrantStore.create: insert for jti "${input.jti}" returned no row`,
      );
    }
    return rowToGrant(row);
  }

  async findByJti(jti: string): Promise<Grant | null> {
    const rows = await this.db
      .select()
      .from(liveGrants)
      .where(eq(liveGrants.jti, jti))
      .limit(1);
    const row = rows[0];
    return row ? rowToGrant(row) : null;
  }

  async bindSession(
    jti: string,
    sessionId: string,
    now: Date,
  ): Promise<Grant | null> {
    const rows = await this.db
      .update(liveGrants)
      .set({ boundSessionId: sessionId })
      .where(
        and(
          eq(liveGrants.jti, jti),
          isNull(liveGrants.boundSessionId),
          gt(liveGrants.expiresAt, now),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? rowToGrant(row) : null;
  }

  async claimCall(jti: string, now: Date): Promise<Grant | null> {
    const rows = await this.db
      .update(liveGrants)
      .set({ usedCalls: sql`${liveGrants.usedCalls} + 1` })
      .where(
        and(
          eq(liveGrants.jti, jti),
          lt(liveGrants.usedCalls, liveGrants.maxCalls),
          gt(liveGrants.expiresAt, now),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? rowToGrant(row) : null;
  }
}

/**
 * Postgres/Drizzle implementation of `LiveBudgetStore` — the global daily
 * backstop, independent of any single grant. `claimCall`'s two statements
 * (ensure-row, then atomic conditional increment) are documented in
 * `ports/grant-store.ts`'s header; the gating decision is entirely the
 * second statement's atomic `UPDATE ... WHERE ... RETURNING`.
 */
export class PgLiveBudgetStore implements LiveBudgetStore {
  constructor(private readonly db: Database) {}

  async claimCall(
    day: string,
    cap: number,
  ): Promise<{ usedCalls: number } | null> {
    await this.db.insert(liveBudget).values({ day }).onConflictDoNothing();
    const rows = await this.db
      .update(liveBudget)
      .set({ usedCalls: sql`${liveBudget.usedCalls} + 1` })
      .where(and(eq(liveBudget.day, day), lt(liveBudget.usedCalls, cap)))
      .returning();
    const row = rows[0];
    return row ? { usedCalls: row.usedCalls } : null;
  }
}
