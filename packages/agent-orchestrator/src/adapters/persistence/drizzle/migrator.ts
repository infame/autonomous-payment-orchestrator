import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./db.js";

/**
 * The migrations folder is resolved relative to this module's own location
 * (`import.meta.url`), not `process.cwd()` — this file is imported both from
 * `run-migrate.ts` (repo-root cwd) and from `vitest.integration.config.ts`'s
 * `globalSetup` (vitest's cwd), so a cwd-relative path would break one of the
 * two callers depending on how the process was launched.
 */
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../drizzle",
);

/**
 * Apply all pending migrations from `drizzle/` to the given database.
 *
 * `migrationsSchema: "agent"` is load-bearing, not cosmetic: it puts this
 * package's migration journal at `agent.__drizzle_migrations` instead of
 * the driver's default (shared, cross-package) location, so applying
 * agent-orchestrator's migrations can never mark pay-core's or
 * durable-ledger's as applied (or vice versa) against the shared Postgres
 * instance. See `schema.ts`'s header comment for the full rationale.
 */
export async function migrate(db: Database): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder, migrationsSchema: "agent" });
}
