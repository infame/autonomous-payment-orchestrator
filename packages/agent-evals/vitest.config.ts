import { defineConfig } from "vitest/config";

/**
 * The dist exclude matters: `pnpm run build` compiles *.test.ts into dist,
 * and without it vitest would run every test a second time from there.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
