/**
 * CLI entry point for `pnpm db:migrate`. Thin wrapper around the programmatic
 * `migrate()` used elsewhere (a future composition root, integration test
 * setup) so there is exactly one migration code path.
 */
import { createDb, createPool } from "./db.js";
import { migrate } from "./migrator.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }
  const pool = createPool(databaseUrl);
  try {
    await migrate(createDb(pool));
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

await main();
