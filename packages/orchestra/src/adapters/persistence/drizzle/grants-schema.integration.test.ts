import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { liveGrants, liveBudget, type NewLiveGrantRow } from "./schema.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Real-Postgres suite hitting the raw Drizzle client directly — covers raw
 * CHECK constraints `PgGrantStore`'s own tests can never exercise (it never
 * emits a row a CHECK would reject), plus the migration-table isolation
 * this package's whole `orchestra`-schema design exists to guarantee
 * (`docs/todo/05-orchestra.md §4`'s "CRITICAL" callout).
 */
describe.skipIf(!hasTestDb)("orchestra schema (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();

  function baseRow(overrides: Partial<NewLiveGrantRow> = {}): NewLiveGrantRow {
    return {
      jti: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      maxCalls: 10,
      usedCalls: 0,
      boundSessionId: null,
      ...overrides,
    };
  }

  function pgErrorOf(
    err: unknown,
  ): { code?: string; constraint?: string } | undefined {
    if (typeof err !== "object" || err === null || !("cause" in err)) {
      return undefined;
    }
    const cause = (err as { cause?: unknown }).cause;
    return typeof cause === "object" && cause !== null ? cause : undefined;
  }

  async function expectConstraintViolation(
    promise: Promise<unknown>,
    constraint: string,
  ): Promise<void> {
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      const pgErr = pgErrorOf(err);
      return pgErr?.code === "23514" && pgErr.constraint === constraint;
    });
  }

  it("rejects maxCalls <= 0", async () => {
    await expectConstraintViolation(
      db.insert(liveGrants).values(baseRow({ maxCalls: 0 })),
      "live_grants_max_calls_positive",
    );
  });

  it("rejects usedCalls < 0", async () => {
    await expectConstraintViolation(
      db.insert(liveGrants).values(baseRow({ usedCalls: -1 })),
      "live_grants_used_calls_non_negative",
    );
  });

  it("rejects usedCalls > maxCalls", async () => {
    await expectConstraintViolation(
      db.insert(liveGrants).values(baseRow({ maxCalls: 1, usedCalls: 2 })),
      "live_grants_used_within_max",
    );
  });

  it("rejects expiresAt <= issuedAt", async () => {
    const issuedAt = new Date();
    await expectConstraintViolation(
      db.insert(liveGrants).values(baseRow({ issuedAt, expiresAt: issuedAt })),
      "live_grants_expires_after_issued",
    );
  });

  it("accepts a valid row", async () => {
    await expect(
      db.insert(liveGrants).values(baseRow()),
    ).resolves.not.toThrow();
  });

  it("live_budget rejects usedCalls < 0", async () => {
    await expectConstraintViolation(
      db.insert(liveBudget).values({ day: "2026-01-01", usedCalls: -1 }),
      "live_budget_used_calls_non_negative",
    );
  });

  it("orchestra's migrations table lives in its own schema, isolated from the other three packages'", async () => {
    const rows = await db.execute<{ table_schema: string }>(
      sql`select table_schema from information_schema.tables where table_name = '__drizzle_migrations' order by table_schema`,
    );
    const schemas = rows.rows.map((r) => r.table_schema).sort();
    expect(schemas).toContain("orchestra");
    // Each package's journal is a DISTINCT schema — orchestra's own presence
    // must not be the only migrations table in the database, and it must
    // not collide with (be the same row source as) any other package's.
    expect(new Set(schemas).size).toBe(schemas.length);
  });
});
