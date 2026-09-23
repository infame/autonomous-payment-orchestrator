/**
 * Process entrypoint for the runnable `@apo/agent-orchestrator` HTTP
 * service. Not exported from `index.ts` — importing the library as a
 * dependency must never start a listener; this file is only ever run
 * directly (`node dist/main.js` / `pnpm start`). Mirrors
 * `@apo/pay-core`'s and `@apo/durable-ledger`'s `main.ts` structure exactly.
 *
 * Wrapped in a top-level `try`/`catch` so a startup failure logs one clear
 * line and `process.exit(1)`s instead of surfacing as an unhandled
 * rejection.
 */
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig, ConfigError, type AppConfig } from "./config.js";
import { createDb, createPool } from "./adapters/persistence/drizzle/db.js";
import { migrate } from "./adapters/persistence/drizzle/migrator.js";
import {
  createAgentOrchestrator,
  type LlmOptions,
} from "./composition-root.js";

let shuttingDown = false;

/** Runs pending migrations against a short-lived pool, separate from the
 * long-lived pool `createAgentOrchestrator` builds for request traffic.
 * Mirrors what `run-migrate.ts` already does for the standalone
 * `db:migrate` script, and what pay-core's/durable-ledger's own `main.ts`
 * do for their migrations. */
async function migrateOnBoot(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await migrate(createDb(pool));
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

/**
 * Builds the configured `LlmOptions` via an explicit if/else, not an
 * unconditional object spread: on the `live` arm, this re-checks
 * `cfg.ANTHROPIC_API_KEY !== undefined` rather than asserting past the
 * compiler with `!`. `loadConfig`'s `superRefine` already guarantees
 * `ANTHROPIC_API_KEY` is set whenever `LLM_MODE=live`, but TypeScript can't
 * see across that module boundary, so this re-checks it instead of trusting
 * a non-null assertion — same reasoning `pay-core`'s own `main.ts` gives for
 * its `buildProvider`'s `SIMULATOR_SEED` re-check.
 */
function buildLlmOptions(cfg: AppConfig): LlmOptions {
  if (cfg.LLM_MODE === "mock") {
    return { mode: "mock" };
  }
  const apiKey = cfg.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    // Unreachable: loadConfig's superRefine rejects this combination at
    // boot before we ever get here.
    throw new ConfigError("ANTHROPIC_API_KEY is required when LLM_MODE=live");
  }
  return {
    mode: "live",
    apiKey,
    model: cfg.ANTHROPIC_MODEL,
    ...(cfg.ANTHROPIC_BASE_URL !== undefined
      ? { baseUrl: cfg.ANTHROPIC_BASE_URL }
      : {}),
    ...(cfg.ANTHROPIC_MAX_RETRIES !== undefined
      ? { maxRetries: cfg.ANTHROPIC_MAX_RETRIES }
      : {}),
    timeoutMs: cfg.LLM_TIMEOUT_MS,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.MIGRATE_ON_BOOT) {
    await migrateOnBoot(cfg.DATABASE_URL);
  }

  const orchestrator = createAgentOrchestrator({
    databaseUrl: cfg.DATABASE_URL,
    durableLedgerUrl: cfg.DURABLE_LEDGER_URL,
    durableLedgerServiceSecret: cfg.DURABLE_LEDGER_SERVICE_SECRET,
    durableLedgerTimeoutMs: cfg.DURABLE_LEDGER_TIMEOUT_MS,
    paymentMethodToken: cfg.PAYMENT_METHOD_TOKEN,
    llm: buildLlmOptions(cfg),
    policy: {
      allowedCurrencies: cfg.POLICY_ALLOWED_CURRENCIES,
      maxAutoApproveAmount: cfg.POLICY_MAX_AUTO_APPROVE_AMOUNT,
      maxHardLimitAmount: cfg.POLICY_MAX_HARD_LIMIT_AMOUNT,
      dailyRateLimit: cfg.POLICY_DAILY_RATE_LIMIT,
    },
  });

  const server: ServerType = serve(
    { fetch: orchestrator.app.fetch, port: cfg.PORT, hostname: cfg.HOST },
    (info) => {
      console.log(
        `agent-orchestrator listening on ${info.address}:${info.port}`,
      );
    },
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    // Arms a hard-exit fallback for the shutdown sequence itself: if
    // `server.close()`/`orchestrator.close()` hang, this fires before
    // Docker's own SIGKILL, so the failure is explicit and logged rather
    // than silent.
    const forceExitTimer = setTimeout(() => {
      console.error(
        `agent-orchestrator: shutdown did not finish within ${cfg.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, cfg.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        await orchestrator.close();
        console.log(`agent-orchestrator (${signal}): shut down cleanly`);
        process.exit(0);
      } catch (err) {
        console.error("agent-orchestrator: error during shutdown", err);
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
  console.error("agent-orchestrator: failed to start", err);
  process.exit(1);
}
