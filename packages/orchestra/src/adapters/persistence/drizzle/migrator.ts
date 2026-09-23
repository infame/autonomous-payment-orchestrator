import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./db.js";

/**
 * The migrations folder is resolved relative to this module's own location
 * (`import.meta.url`), not `process.cwd()` — mirrors
 * `@apo/agent-orchestrator`'s `migrator.ts`, for the same reason: this file
 * is imported both from `run-migrate.ts` (repo-root cwd) and from
 * `vitest.integration.config.ts`'s `globalSetup` (vitest's cwd).
 */
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../drizzle",
);

/**
 * Apply all pending migrations from `drizzle/` to the given database.
 *
 * `migrationsSchema: "orchestra"` is load-bearing, not cosmetic: it puts
 * this package's migration journal at `orchestra.__drizzle_migrations`
 * instead of the driver's default (shared, cross-package) location, so
 * applying orchestra's migrations can never mark pay-core's/durable-ledger's/
 * agent-orchestrator's migrations as applied, or vice versa, against the
 * shared Postgres instance — see `schema.ts`'s header and
 * `docs/todo/05-orchestra.md §4`'s "CRITICAL" callout: a migrations-table
 * collision here is SILENT, not an error.
 */
export async function migrate(db: Database): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder, migrationsSchema: "orchestra" });
}
