import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * A generic, real-socket HTTP fake shared by `demo/scenarios.test.ts` and
 * `adapters/http/gateway-app.test.ts` (ADR-0006's pattern: a real
 * `node:http` server over a real socket, not an in-process stub — the same
 * reasoning `@apo/agent-orchestrator`'s `fake-durable-ledger-server.ts`
 * documents applies here since `orchestra` has no `workspace:*` import of
 * any sibling to build an in-process fake against, ADR-0020). A test
 * supplies an ordered list of `ScriptedRoute`s; each incoming request is
 * matched against them in order, the first match wins, and matched routes
 * are consumed one at a time UNLESS `repeat: true` — this is what lets a
 * test script "first GET returns executing, second GET returns completed"
 * without hand-rolling per-call state.
 */

export interface ScriptedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface ScriptedResponse {
  readonly status: number;
  readonly body: unknown;
  /** Sends these bytes verbatim instead of JSON-stringifying `body`; used to prove malformed-upstream handling. */
  readonly rawBody?: string;
}

export interface ScriptedRoute {
  readonly method: string;
  /** Matched against the raw path (no query string) with `RegExp.test`. */
  readonly path: RegExp;
  readonly respond:
    ScriptedResponse | ((req: ScriptedRequest) => ScriptedResponse);
  /** When true, this route is never consumed — it can match any number of requests. Default false (consumed after one match). */
  readonly repeat?: boolean;
}

export interface ScriptedServer {
  readonly baseUrl: string;
  readonly requests: ScriptedRequest[];
  close(): Promise<void>;
}

function buildHeaderRecord(rawHeaders: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && !(name in record)) {
      record[name.toLowerCase()] = value;
    }
  }
  return record;
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Starts a scripted fake on an OS-assigned port. `routes` is mutable — tests can splice/push into it to change what's scripted mid-run, since matching reads the live array on every request. */
export function startScriptedServer(
  routes: ScriptedRoute[],
): Promise<ScriptedServer> {
  const requests: ScriptedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const bodyText = await readBody(req);
      const [rawPath = "/"] = (req.url ?? "/").split("?");
      const headers = buildHeaderRecord(req.rawHeaders);
      const method = req.method ?? "GET";
      const scriptedReq: ScriptedRequest = {
        method,
        path: rawPath,
        headers,
        body: parseJson(bodyText),
      };
      requests.push(scriptedReq);

      const matchIndex = routes.findIndex(
        (route) => route.method === method && route.path.test(rawPath),
      );
      if (matchIndex === -1) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "not_found", message: "Not found (unscripted)" },
          }),
        );
        return;
      }
      const route = routes[matchIndex];
      if (route === undefined) {
        return;
      }
      if (route.repeat !== true) {
        routes.splice(matchIndex, 1);
      }
      const resolved =
        typeof route.respond === "function"
          ? route.respond(scriptedReq)
          : route.respond;
      res.writeHead(resolved.status, { "content-type": "application/json" });
      res.end(
        resolved.rawBody ??
          (resolved.body === undefined ? "" : JSON.stringify(resolved.body)),
      );
    })();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(
          new Error("startScriptedServer: server did not bind to a TCP port"),
        );
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
