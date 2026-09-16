import { defineConfig } from "drizzle-kit";

/**
 * `schemaFilter: ["agent"]` stops drizzle-kit from ever proposing to touch
 * (or drop) `pay-core`'s `public`-schema tables, or `durable-ledger`'s
 * `ledger`-schema tables, when it introspects the shared Postgres instance
 * — this package's tables all live in their own `agent` schema (see
 * `src/adapters/persistence/drizzle/schema.ts`). `migrations.schema: "agent"`
 * keeps the migration journal itself (`__drizzle_migrations`) in that same
 * schema, isolated from the other two packages' — see `migrator.ts` for why
 * that isolation matters at apply time.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/persistence/drizzle/schema.ts",
  out: "./drizzle",
  schemaFilter: ["agent"],
  migrations: { schema: "agent", table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://apo:apo@localhost:5433/apo",
  },
});
