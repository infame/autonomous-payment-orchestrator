import { defineConfig } from "vitest/config";

/**
 * `pnpm test:integration` — real-Postgres suites only (`*.integration.test.ts`).
 * `fileParallelism: false` because these suites share one database and lean
 * on `TRUNCATE ... CASCADE` between tests; running files concurrently would
 * have one suite's truncate race another's assertions. `globalSetup` applies
 * migrations once before any suite runs.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    globalSetup: ["./src/adapters/persistence/drizzle/vitest-global-setup.ts"],
  },
});
