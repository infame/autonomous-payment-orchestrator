import type { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import {
  createPool,
  createDb,
  type PgPool,
} from "./adapters/persistence/drizzle/db.js";
import { PgLedgerRepository } from "./adapters/persistence/drizzle/pg-ledger-repository.js";
import { InMemoryLedgerRepository } from "./adapters/memory/in-memory-ledger-repository.js";
import { HttpPayCoreClient } from "./adapters/http/pay-core-client.js";
import type { PayCoreClient } from "./ports/pay-core-client.js";
import { createInngestClient } from "./adapters/inngest/client.js";
import { InngestWorkflowRuns } from "./adapters/inngest/inngest-workflow-runs.js";
import type { WorkflowRuns } from "./ports/workflow-runs.js";
import type { LedgerRepository } from "./ports/ledger-repository.js";
import { createPaymentExecuteFunction } from "./workflow/payment-execute.js";
import type { DecideRetryOptions } from "./workflow/retry-policy.js";
import { createLedgerApp } from "./adapters/http/app.js";

export interface CreateDurableLedgerOptions {
  readonly databaseUrl: string;
  readonly serviceSecret: string;
  readonly payCoreUrl: string;
  readonly payCoreTimeoutMs?: number;
  readonly inngest: {
    readonly appId?: string;
    readonly isDev: boolean;
    readonly baseUrl?: string;
    /** Falls back to `baseUrl` in dev mode; cloud deployments configure this explicitly while leaving `baseUrl` absent. */
    readonly apiBaseUrl?: string;
    readonly eventKey?: string;
    readonly signingKey?: string;
    readonly servePath?: string;
  };
  readonly retry?: DecideRetryOptions;
}

export interface DurableLedger {
  readonly app: Hono;
  readonly ledger: LedgerRepository;
  readonly runs: WorkflowRuns;
  /** Closes the underlying connection pool. Call once on shutdown. */
  close(): Promise<void>;
}

/**
 * Builds a ready-to-use durable-ledger service against real Postgres,
 * pay-core (over HTTP), and Inngest: the Hono `app` (including the mounted
 * Inngest `serve()` endpoint), the `LedgerRepository`, and the `WorkflowRuns`
 * port. Mirrors `@apo/pay-core`'s `createPayCore` in shape.
 *
 * The `payment.execute` Inngest function is constructed and handed to
 * `inngestServe(...)` inline, in the same expression, rather than assigned
 * to an intermediately-annotated variable first — this is the exact shape
 * that historically collapsed Inngest's own generic type inference for this
 * package (ADR-0008); `inngest/hono`'s looser `serve()` typing likely
 * doesn't hit the same trap, but there's no upside to re-testing that
 * boundary here.
 */
export function createDurableLedger(
  options: CreateDurableLedgerOptions,
): DurableLedger {
  const pool: PgPool = createPool(options.databaseUrl);
  const db = createDb(pool);
  const ledger = new PgLedgerRepository(db);

  const payCore = new HttpPayCoreClient({
    baseUrl: options.payCoreUrl,
    ...(options.payCoreTimeoutMs !== undefined
      ? { timeoutMs: options.payCoreTimeoutMs }
      : {}),
  });

  const inngest = createInngestClient({
    ...(options.inngest.appId !== undefined
      ? { id: options.inngest.appId }
      : {}),
    isDev: options.inngest.isDev,
    ...(options.inngest.baseUrl !== undefined
      ? { baseUrl: options.inngest.baseUrl }
      : {}),
    ...(options.inngest.eventKey !== undefined
      ? { eventKey: options.inngest.eventKey }
      : {}),
    ...(options.inngest.signingKey !== undefined
      ? { signingKey: options.inngest.signingKey }
      : {}),
  });

  const apiBaseUrl =
    options.inngest.apiBaseUrl ??
    options.inngest.baseUrl ??
    "http://localhost:8288";
  const runs = new InngestWorkflowRuns({
    inngest,
    apiBaseUrl,
    ...(options.inngest.signingKey !== undefined
      ? { signingKey: options.inngest.signingKey }
      : {}),
  });

  const app = createLedgerApp({
    ledger,
    runs,
    serviceSecret: options.serviceSecret,
    inngestHandler: inngestServe({
      client: inngest,
      functions: [
        createPaymentExecuteFunction({
          inngest,
          payCore,
          ledger,
          ...(options.retry !== undefined ? { retry: options.retry } : {}),
        }),
      ],
    }),
    ...(options.inngest.servePath !== undefined
      ? { inngestServePath: options.inngest.servePath }
      : {}),
  });

  return {
    app,
    ledger,
    runs,
    close: () => pool.end(),
  };
}

/**
 * Builds a durable-ledger `app` against the in-memory ledger adapter, for
 * tests and local demos — no database, no live Inngest, no `close()`. The
 * HTTP app built here only ever needs `ledger` and `runs` (there is no
 * Inngest `serve()` endpoint to mount without a real `Inngest` client), but
 * `payCore` is accepted anyway to keep this factory's option shape stable
 * against `createDurableLedger`'s — a future in-memory Inngest wiring (e.g.
 * against `@inngest/test`) would need it without changing every call site.
 * Authentication is intentionally production-shaped: callers must provide
 * a valid service secret, and this factory exposes no unauthenticated mode.
 */
export function createInMemoryDurableLedger(options: {
  readonly payCore: PayCoreClient;
  readonly runs: WorkflowRuns;
  readonly serviceSecret: string;
}): {
  readonly app: Hono;
  readonly ledger: InMemoryLedgerRepository;
  readonly runs: WorkflowRuns;
} {
  const ledger = new InMemoryLedgerRepository();
  const app = createLedgerApp({
    ledger,
    runs: options.runs,
    serviceSecret: options.serviceSecret,
  });
  return { app, ledger, runs: options.runs };
}
