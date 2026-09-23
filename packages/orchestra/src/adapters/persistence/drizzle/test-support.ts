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
 * truncates `orchestra.live_grants`/`orchestra.live_budget` before every
 * test, and closes the pool once the suite finishes. Migrations are applied
 * once, globally, before any suite runs
 * (`vitest.integration.config.ts`'s `globalSetup`). Mirrors
 * `@apo/agent-orchestrator`'s `test-support.ts`.
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
  await db.execute(sql`TRUNCATE orchestra.live_grants CASCADE`);
  await db.execute(sql`TRUNCATE orchestra.live_budget CASCADE`);
}
