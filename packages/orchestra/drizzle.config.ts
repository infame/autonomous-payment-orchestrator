import { defineConfig } from "drizzle-kit";

/**
 * `schemaFilter: ["orchestra"]` stops drizzle-kit from ever proposing to
 * touch (or drop) `pay-core`'s `public`-schema tables, `durable-ledger`'s
 * `ledger`-schema tables, or `agent-orchestrator`'s `agent`-schema tables,
 * when it introspects the shared Postgres instance — this package's tables
 * all live in their own `orchestra` schema (see
 * `src/adapters/persistence/drizzle/schema.ts`). `migrations.schema:
 * "orchestra"` keeps the migration journal itself (`__drizzle_migrations`)
 * in that same schema, isolated from the other three packages' — see
 * `migrator.ts` for why that isolation matters at apply time.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/persistence/drizzle/schema.ts",
  out: "./drizzle",
  schemaFilter: ["orchestra"],
  migrations: { schema: "orchestra", table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://apo:apo@localhost:5433/apo",
  },
});
