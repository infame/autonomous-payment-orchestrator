import { Hono } from "hono";
import type { Context } from "hono";
import type { LedgerRepository } from "../../ports/ledger-repository.js";
import type { WorkflowRuns } from "../../ports/workflow-runs.js";
import { LedgerAccount } from "../../domain/account.js";
import {
  StartPaymentWorkflowBody,
  EventIdParam,
  LedgerEntriesQuery,
  CurrencyQuery,
} from "./server-schemas.js";
import { toLedgerEntryView } from "./ledger-view.js";
import { optionalIdempotencyKey, readJsonBody } from "./request.js";
import { HttpError, mapError } from "./server-error-mapper.js";

export interface LedgerAppDeps {
  readonly ledger: LedgerRepository;
  readonly runs: WorkflowRuns;
  /** The Inngest `serve()` handler, when one is wired (`../../composition-root.js`). Omitted lets tests build an app with no live Inngest at all. */
  readonly inngestHandler?: (c: Context) => Promise<Response>;
  readonly inngestServePath?: string;
}

const DEFAULT_INNGEST_SERVE_PATH = "/api/inngest";

/**
 * Builds the driving HTTP adapter for `durable-ledger`: a Hono `app` wired
 * against `LedgerRepository` and `WorkflowRuns`. Route handlers stay small
 * — read param, validate, call the port, return the result — and never
 * catch: every error propagates to the single `app.onError` below, which
 * maps it through `mapError`. Mirrors `packages/pay-core/src/adapters/http/app.ts`'s
 * shape and conventions.
 */
export function createLedgerApp(deps: LedgerAppDeps): Hono {
  const app = new Hono();

  app.post("/workflows/payment", async (c) => {
    // Read/validate the header before touching the request body, so a
    // malformed Idempotency-Key fails fast without consuming the stream.
    const key = optionalIdempotencyKey(c);
    const body = StartPaymentWorkflowBody.parse(await readJsonBody(c));
    const { eventId } = await deps.runs.startPaymentExecute(
      body,
      key === undefined ? undefined : { idempotencyKey: key },
    );
    return c.json({ eventId, statusUrl: `/workflows/${eventId}` }, 202);
  });

  app.get("/workflows/:eventId", async (c) => {
    const eventId = EventIdParam.parse(c.req.param("eventId"));
    const snapshot = await deps.runs.findByEventId(eventId);
    if (snapshot === null) {
      throw new HttpError(
        404,
        "workflow_run_not_found",
        `No workflow run found for event "${eventId}"`,
      );
    }
    return c.json(snapshot, 200);
  });

  app.get("/ledger/entries", async (c) => {
    const query = LedgerEntriesQuery.parse({
      paymentId: c.req.query("paymentId"),
      operationId: c.req.query("operationId"),
    });
    // `LedgerEntriesQuery`'s `.refine` already guarantees exactly one of
    // `paymentId`/`operationId` is defined; TypeScript can't see across that
    // boundary, so the `!` below is a narrowing aid, not an escape from it.
    const entries =
      query.paymentId !== undefined
        ? await deps.ledger.findByPaymentId(query.paymentId)
        : await deps.ledger.findByOperationId(query.operationId!);
    return c.json({ entries: entries.map(toLedgerEntryView) }, 200);
  });

  app.get("/ledger/accounts/:account/balance", async (c) => {
    const account = LedgerAccount.parse(
      decodeURIComponent(c.req.param("account")),
    );
    const currency = CurrencyQuery.parse(c.req.query("currency"));
    const balance = await deps.ledger.getBalance(account, currency);
    return c.json(
      { account: account.toString(), currency, balance: balance.toJSON() },
      200,
    );
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }, 200));

  if (deps.inngestHandler !== undefined) {
    app.on(
      ["GET", "POST", "PUT"],
      deps.inngestServePath ?? DEFAULT_INNGEST_SERVE_PATH,
      deps.inngestHandler,
    );
  }

  app.onError((err, c) => {
    const { status, body } = mapError(err);
    return c.json(body, status);
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Not found" } }, 404),
  );

  return app;
}
