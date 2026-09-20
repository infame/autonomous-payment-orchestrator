import { defineConfig } from "vitest/config";

/**
 * Default config for `pnpm test` (also `vitest`/`vitest run` with no
 * `--config`). Excludes `*.integration.test.ts` so a plain `pnpm test` (no
 * Docker, no `DATABASE_URL`) stays green — there are none in this package
 * yet, but a future integration step will add one and it must not get
 * silently pulled into this default run.
 *
 * The dist exclude matters: `pnpm run build` compiles *.test.ts into dist,
 * and without it vitest would run every test a second time from there.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
