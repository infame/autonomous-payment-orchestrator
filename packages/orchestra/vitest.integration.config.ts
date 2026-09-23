import { defineConfig } from "vitest/config";

/**
 * `pnpm test:integration` — real-Postgres suites only
 * (`*.integration.test.ts`). `fileParallelism: false` because these suites
 * share one database and lean on truncation between tests. `globalSetup`
 * applies migrations once before any suite runs. Mirrors
 * `@apo/agent-orchestrator`'s `vitest.integration.config.ts`.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    globalSetup: ["./src/adapters/persistence/drizzle/vitest-global-setup.ts"],
  },
});
