import { createDb, createPool } from "./db.js";
import { migrate } from "./migrator.js";
import { testDatabaseUrl } from "./test-db-url.js";

/**
 * Runs once before the whole `test:integration` run (see `globalSetup` in
 * `vitest.integration.config.ts`), not once per suite — migrations are
 * idempotent but there is no reason to pay for them `fileParallelism`-many
 * times. Failure here (e.g. Postgres isn't up) must fail the run loudly, not
 * be swallowed into a per-suite skip.
 */
export default async function setup(): Promise<void> {
  const pool = createPool(testDatabaseUrl());
  try {
    await migrate(createDb(pool));
  } finally {
    await pool.end();
  }
}
