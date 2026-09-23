import { defineConfig } from "vitest/config";

/**
 * Default config for `pnpm test` (also `vitest`/`vitest run` with no
 * `--config`). Excludes `*.integration.test.ts` so a plain `pnpm test` (no
 * Docker, no `DATABASE_URL`) stays green. Mirrors
 * `@apo/agent-orchestrator`'s `vitest.config.ts`.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
