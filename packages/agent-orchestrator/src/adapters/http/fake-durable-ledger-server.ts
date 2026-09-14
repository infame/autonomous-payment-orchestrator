import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Test support only — deliberately NOT exported from `src/index.ts`. The
 * wire contract implemented below is transcribed from
 * `packages/durable-ledger/src/adapters/http/app.ts` and
 * `packages/durable-ledger/src/adapters/http/server-error-mapper.ts`; if
 * durable-ledger's real contract ever drifts from this fake, those two
 * files are where to check first. See
 * `docs/adr/0006-fake-pay-core-in-client-tests.md` for why tests exercise a
 * real `node:http` server over real sockets rather than an in-process
 * stub — the same reasoning applies here: `@apo/durable-ledger` declares no
 * `main`/`types`/`exports`, so it isn't importable as a workspace
 * dependency, and even if it were, only a real socket honestly exercises
 * `fetch`/timeout/`AbortSignal` combination.
 */

export interface FakeRequestContext {
  readonly method: string;
  /** Raw path (no query string), e.g. `/workflows/payment`. Never decoded — a `%2F` in an id stays a `%2F`. */
  readonly path: string;
  /** First-seen casing per header name, as received on the wire. */
  readonly headers: Record<string, string>;
  readonly body: string;
  /** Decoded `:eventId` path segment, when the route has one. */
  readonly eventId: string | undefined;
}

/** Full control of the response — a test override can write any status/headers/body, delay before responding, or destroy the socket directly via `res`. */
export type RouteHandler = (
  ctx: FakeRequestContext,
  res: ServerResponse,
) => void | Promise<void>;

export interface RouteHandlers {
  startPaymentWorkflow: RouteHandler;
  getRunStatus: RouteHandler;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface FakeDurableLedgerServer {
  readonly baseUrl: string;
  close(): Promise<void>;
  readonly requests: RecordedRequest[];
}

/** A plain status/body triple — what the DEFAULT handlers compute before being wired to a real `res`. */
interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

/** Wraps a pure `ctx -> FakeResponse` default handler as a real `RouteHandler` that writes it to `res`. */
function wireDefaultHandler(
  handler: (ctx: FakeRequestContext) => FakeResponse,
): RouteHandler {
  return (ctx, res) => {
    const { status, body } = handler(ctx);
    sendJson(res, status, body);
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonBody(bodyText: string): Record<string, unknown> {
  if (bodyText.trim() === "") {
    return {};
  }
  try {
    return asRecord(JSON.parse(bodyText));
  } catch {
    return {};
  }
}

function buildHeaderRecord(rawHeaders: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && !(name in record)) {
      record[name] = value;
    }
  }
  return record;
}

/** 26 uppercase Crockford-base32 characters — matches durable-ledger's real `EventIdParam` regex (`server-schemas.ts`, `/^[0-9A-HJKMNP-TV-Z]{26}$/i`). */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function mintFakeEventId(): string {
  let id = "";
  for (let i = 0; i < 26; i += 1) {
    id += ULID_ALPHABET[Math.floor(Math.random() * ULID_ALPHABET.length)];
  }
  return id;
}

interface RunRecord {
  eventId: string;
  runId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  needsReview: boolean;
  failureMessage: string | null;
}

function defaultRunFor(eventId: string): RunRecord {
  return {
    eventId,
    runId: null,
    status: "queued",
    startedAt: null,
    endedAt: null,
    needsReview: false,
    failureMessage: null,
  };
}

function runNotFound(eventId: string | undefined): FakeResponse {
  return {
    status: 404,
    body: {
      error: {
        code: "workflow_run_not_found",
        message: `No workflow run found for event "${eventId ?? ""}"`,
      },
    },
  };
}

function routeNotFound(): FakeResponse {
  return {
    status: 404,
    body: { error: { code: "not_found", message: "Not found" } },
  };
}

/**
 * Pure default handlers, closing over one server instance's run state.
 * Wired to real `RouteHandler`s in `startFakeDurableLedger`.
 *
 * `getRunStatus` supports a per-server-instance scripted status sequence
 * (`runs` stores a live record a test can mutate directly between calls) so
 * a test can drive `queued -> running -> completed` deterministically
 * across repeated calls, or simply set a fixed snapshot once.
 */
function createDefaultHandlers(
  runs: Map<string, RunRecord>,
): Record<keyof RouteHandlers, (ctx: FakeRequestContext) => FakeResponse> {
  return {
    startPaymentWorkflow(ctx) {
      // The body is parsed only to keep the fake honest about what a real
      // durable-ledger would have validated — its fields are never read
      // into the response beyond that, and certainly never echoed into an
      // error message (see durable-ledger-client.test.ts's security pins).
      parseJsonBody(ctx.body);
      const eventId = mintFakeEventId();
      runs.set(eventId, defaultRunFor(eventId));
      return {
        status: 202,
        body: { eventId, statusUrl: `/workflows/${eventId}` },
      };
    },

    getRunStatus(ctx) {
      const record =
        ctx.eventId === undefined ? undefined : runs.get(ctx.eventId);
      if (record === undefined) {
        return runNotFound(ctx.eventId);
      }
      return { status: 200, body: { ...record } };
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Starts a real `node:http` server on an OS-assigned port (`0`) so tests can
 * run in parallel without port collisions. `overrides` replace individual
 * default route handlers — a test's override gets full control of the
 * `ServerResponse` (force any status, delay a response, or immediately
 * destroy the socket) without touching the shared in-memory run state the
 * other route uses. `runs` is also returned so a test can script a status
 * sequence directly (e.g. mutate a stored record's `status` between two
 * `getRunStatus` calls) without needing a handler override at all.
 */
export function startFakeDurableLedger(
  overrides?: Partial<RouteHandlers>,
): Promise<
  FakeDurableLedgerServer & { readonly runs: Map<string, RunRecord> }
> {
  const runs = new Map<string, RunRecord>();
  const defaults = createDefaultHandlers(runs);
  const handlers: RouteHandlers = {
    startPaymentWorkflow: wireDefaultHandler(defaults.startPaymentWorkflow),
    getRunStatus: wireDefaultHandler(defaults.getRunStatus),
    ...overrides,
  };
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const [rawPath = "/"] = (req.url ?? "/").split("?");
      const headers = buildHeaderRecord(req.rawHeaders);
      const method = req.method ?? "GET";

      requests.push({ method, path: rawPath, headers, body });

      const baseCtx = { method, path: rawPath, headers, body };
      const getMatch = /^\/workflows\/([^/]+)$/.exec(rawPath);

      try {
        if (method === "POST" && rawPath === "/workflows/payment") {
          await handlers.startPaymentWorkflow(
            { ...baseCtx, eventId: undefined },
            res,
          );
          return;
        }
        if (method === "GET" && getMatch) {
          await handlers.getRunStatus(
            { ...baseCtx, eventId: decodeSegment(getMatch[1]) },
            res,
          );
          return;
        }
        const { status, body: notFoundBody } = routeNotFound();
        sendJson(res, status, notFoundBody);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: { code: "internal_error", message: String(err) },
          });
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(
          new Error(
            "startFakeDurableLedger: server did not bind to a TCP port",
          ),
        );
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        requests,
        runs,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((closeErr) => {
              if (closeErr) {
                rejectClose(closeErr);
              } else {
                resolveClose();
              }
            });
          }),
      });
    });
  });
}

function decodeSegment(segment: string | undefined): string | undefined {
  return segment === undefined ? undefined : decodeURIComponent(segment);
}
