/**
 * Process entrypoint for the runnable `@apo/orchestra` gateway service.
 * Only ever run directly (`node dist/main.js` / `pnpm start`). Mirrors
 * `@apo/agent-orchestrator`'s/`@apo/durable-ledger`'s/`@apo/pay-core`'s own
 * `main.ts` structure exactly, including the same SIGTERM/SIGINT
 * graceful-shutdown-then-force-exit pattern.
 */
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createPool, createDb } from "./adapters/persistence/drizzle/db.js";
import { migrate } from "./adapters/persistence/drizzle/migrator.js";
import { createOrchestra } from "./composition-root.js";

let shuttingDown = false;

/** Runs pending migrations against a short-lived pool, separate from the long-lived pool `createOrchestra` builds for request traffic. Mirrors the sibling packages' own `main.ts`. */
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

  const orchestra = createOrchestra(cfg);

  const server: ServerType = serve(
    { fetch: orchestra.app.fetch, port: cfg.PORT, hostname: cfg.HOST },
    (info) => {
      console.log(`orchestra listening on ${info.address}:${info.port}`);
    },
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const forceExitTimer = setTimeout(() => {
      console.error(
        `orchestra: shutdown did not finish within ${String(cfg.SHUTDOWN_TIMEOUT_MS)}ms, forcing exit`,
      );
      process.exit(1);
    }, cfg.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        await orchestra.close();
        console.log(`orchestra (${signal}): shut down cleanly`);
        process.exit(0);
      } catch (err) {
        console.error("orchestra: error during shutdown", err);
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
  console.error("orchestra: failed to start", err);
  process.exit(1);
}
