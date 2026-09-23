/**
 * Process entrypoint for the runnable `@apo/durable-ledger` HTTP service. Not
 * exported from `index.ts` — importing the library as a dependency must
 * never start a listener; this file is only ever run directly
 * (`node dist/main.js` / `pnpm start`). Mirrors `@apo/pay-core`'s `main.ts`
 * structure exactly.
 *
 * Wrapped in a top-level `try`/`catch` so a startup failure logs one clear
 * line and `process.exit(1)`s instead of surfacing as an unhandled
 * rejection.
 */
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./adapters/persistence/drizzle/db.js";
import { migrate } from "./adapters/persistence/drizzle/migrator.js";
import { createDurableLedger } from "./composition-root.js";

let shuttingDown = false;

/** Runs pending migrations against a short-lived pool, separate from the
 * long-lived pool `createDurableLedger` builds for request traffic. Mirrors
 * what `run-migrate.ts` already does for the standalone `db:migrate` script,
 * and what pay-core's own `main.ts` does for its migrations. */
async function migrateOnBoot(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await migrate(createDb(pool));
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.MIGRATE_ON_BOOT) {
    await migrateOnBoot(cfg.DATABASE_URL);
  }

  const ledger = createDurableLedger({
    databaseUrl: cfg.DATABASE_URL,
    serviceSecret: cfg.DURABLE_LEDGER_SERVICE_SECRET,
    payCoreUrl: cfg.PAY_CORE_URL,
    payCoreTimeoutMs: cfg.PAY_CORE_TIMEOUT_MS,
    inngest: {
      appId: cfg.INNGEST_APP_ID,
      isDev: cfg.INNGEST_DEV,
      ...(cfg.INNGEST_BASE_URL !== undefined
        ? { baseUrl: cfg.INNGEST_BASE_URL }
        : {}),
      servePath: cfg.INNGEST_SERVE_PATH,
      ...(cfg.INNGEST_API_BASE_URL !== undefined
        ? { apiBaseUrl: cfg.INNGEST_API_BASE_URL }
        : {}),
      ...(cfg.INNGEST_EVENT_KEY !== undefined
        ? { eventKey: cfg.INNGEST_EVENT_KEY }
        : {}),
      ...(cfg.INNGEST_SIGNING_KEY !== undefined
        ? { signingKey: cfg.INNGEST_SIGNING_KEY }
        : {}),
    },
  });

  const server: ServerType = serve(
    { fetch: ledger.app.fetch, port: cfg.PORT, hostname: cfg.HOST },
    (info) => {
      console.log(`durable-ledger listening on ${info.address}:${info.port}`);
    },
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Arms a hard-exit fallback for the shutdown sequence itself: if
    // `server.close()`/`ledger.close()` hang, this fires before Docker's own
    // SIGKILL, so the failure is explicit and logged rather than silent.
    const forceExitTimer = setTimeout(() => {
      console.error(
        `durable-ledger: shutdown did not finish within ${cfg.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, cfg.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        await ledger.close();
        console.log(`durable-ledger (${signal}): shut down cleanly`);
        process.exit(0);
      } catch (err) {
        console.error("durable-ledger: error during shutdown", err);
        process.exit(1);
      }
    })();
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

try {
  await main();
} catch (err) {
  console.error("durable-ledger: failed to start", err);
  process.exit(1);
}
