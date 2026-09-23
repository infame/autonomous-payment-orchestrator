/**
 * Split out from any test-only helper so `vitest-global-setup.ts` (which
 * runs in its own worker context, separate from the normal test runtime)
 * doesn't have to import `vitest` transitively — `globalSetup` modules
 * importing `vitest` fail at runtime. Mirrors
 * `@apo/agent-orchestrator`'s `test-db-url.ts`.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start Postgres with `docker compose up -d` " +
        "and set TEST_DATABASE_URL before running `pnpm test:integration`.",
    );
  }
  return url;
}
