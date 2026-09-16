import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { createDb, createPool, type Database, type PgPool } from "./db.js";
import { testDatabaseUrl } from "./test-db-url.js";

export { testDatabaseUrl } from "./test-db-url.js";

export interface TestDb {
  readonly db: Database;
  readonly pool: PgPool;
}

/**
 * Sets up a pool against the test database for one integration suite:
 * truncates `agent.intents` before every test, and closes the pool once the
 * suite finishes. Migrations are applied once, globally, before any suite
 * runs (`vitest.integration.config.ts`'s `globalSetup`) — not repeated
 * per-suite here. Like `durable-ledger`, this package has exactly one table
 * to clean up.
 */
export function withTestDb(): TestDb {
  const pool = createPool(testDatabaseUrl());
  const db = createDb(pool);

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  return { db, pool };
}

async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE agent.intents CASCADE`);
}
