import { defineConfig } from "vitest/config";

/**
 * Default config for `pnpm test` (also `vitest`/`vitest run` with no
 * `--config`). Excludes `*.integration.test.ts` so a plain `pnpm test` (no
 * Docker, no `DATABASE_URL`) stays green — there are none in this package
 * yet, but a future Postgres step (spec §5) will add one and it must not
 * get silently pulled into this default run.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
