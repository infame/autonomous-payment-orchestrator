import type { Hono } from "hono";
import {
  createPool,
  createDb,
  type PgPool,
} from "./adapters/persistence/drizzle/db.js";
import {
  PgGrantStore,
  PgLiveBudgetStore,
} from "./adapters/persistence/drizzle/pg-grant-store.js";
import { createGatewayApp } from "./adapters/http/gateway-app.js";
import type { AppConfig } from "./config.js";

export interface Orchestra {
  readonly app: Hono;
  /** Closes the underlying connection pool. Call once on shutdown. */
  close(): Promise<void>;
}

/**
 * Builds a ready-to-use `orchestra` gateway service against real Postgres
 * and the two `agent-orchestrator` instances (mock always, live only when
 * configured). Mirrors `@apo/agent-orchestrator`'s/`@apo/durable-ledger`'s/
 * `@apo/pay-core`'s own `createXxx` composition roots in shape.
 */
export function createOrchestra(cfg: AppConfig): Orchestra {
  const pool: PgPool = createPool(cfg.DATABASE_URL);
  const db = createDb(pool);
  const grantStore = new PgGrantStore(db);
  const liveBudgetStore = new PgLiveBudgetStore(db);

  const app = createGatewayApp({
    grantStore,
    liveBudgetStore,
    adminSecret: cfg.ADMIN_SECRET,
    grantSigningKey: cfg.GRANT_SIGNING_KEY,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
    agentOrchestratorUrl: cfg.AGENT_ORCHESTRATOR_URL,
    agentOrchestratorLiveUrl: cfg.AGENT_ORCHESTRATOR_LIVE_URL,
    grantDefaultTtlSeconds: cfg.GRANT_DEFAULT_TTL_SECONDS,
    grantDefaultMaxCalls: cfg.GRANT_DEFAULT_MAX_CALLS,
    liveCallsPerDay: cfg.LIVE_CALLS_PER_DAY,
  });

  return { app, close: () => pool.end() };
}
