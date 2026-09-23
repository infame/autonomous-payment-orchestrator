import { createDb, createPool } from "./db.js";
import { migrate } from "./migrator.js";
import { testDatabaseUrl } from "./test-db-url.js";

/**
 * Runs once before the whole `test:integration` run (`globalSetup` in
 * `vitest.integration.config.ts`), not once per suite. Mirrors
 * `@apo/agent-orchestrator`'s `vitest-global-setup.ts`.
 */
export default async function setup(): Promise<void> {
  const pool = createPool(testDatabaseUrl());
  try {
    await migrate(createDb(pool));
  } finally {
    await pool.end();
  }
}
