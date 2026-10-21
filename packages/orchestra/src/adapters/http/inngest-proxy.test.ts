import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayApp } from "./gateway-app.js";
import {
  InMemoryGrantStore,
  InMemoryLiveBudgetStore,
} from "../../test-support/adapters/in-memory-grant-store.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function setup(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  enabled = true,
  timeout = 1000,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return createGatewayApp({
    grantStore: new InMemoryGrantStore(),
    liveBudgetStore: new InMemoryLiveBudgetStore(),
    adminSecret: undefined,
    grantSigningKey: undefined,
    publicBaseUrl: "https://demo.example.com",
    agentOrchestratorUrl: `http://127.0.0.1:${String(address.port)}`,
    agentOrchestratorLiveUrl: undefined,
    grantDefaultTtlSeconds: 86400,
    grantDefaultMaxCalls: 20,
    liveCallsPerDay: 200,
    defaultUpstreamTimeoutMs: timeout,
    ...(enabled
      ? {
          inngestCallbackUrl: `http://127.0.0.1:${String(address.port)}/api/inngest`,
        }
      : {}),
  });
}
describe("Inngest callback boundary", () => {
  it.each(["GET", "POST", "PUT"])(
    "preserves %s query/raw bytes/SDK headers and strips identity",
    async (method) => {
      let observed:
        | {
            path: string | undefined;
            body: string;
            headers: IncomingMessage["headers"];
            method: string | undefined;
          }
        | undefined;
      const raw = '{ "x": [1, 2], "unicode": "π" }\n';
      const app = await setup((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        req.on("end", () => {
          observed = {
            path: req.url,
            method: req.method,
            body: Buffer.concat(chunks).toString(),
            headers: req.headers,
          };
          res.writeHead(202, {
            "x-inngest-signature": "response-signature",
            "content-type": "application/json",
            "set-cookie": "evil=1",
          });
          res.end('{"ok":true}');
        });
      });
      const response = await app.request(
        "https://demo.example.com/api/inngest?fnId=a%2Fb&stepId=x",
        {
          method,
          headers: {
            host: "demo.example.com",
            "content-type": "application/json",
            "x-inngest-signature": "signature",
            "x-inngest-sync-kind": "in-band",
            cookie: "apo_customer_id=visitor",
            "x-customer-id": "fake",
            "x-service-secret": "secret",
            authorization: "secret",
            "x-forwarded-host": "evil",
          },
          ...(method === "GET" ? {} : { body: raw }),
        },
      );
      expect(response.status).toBe(202);
      expect(await response.text()).toBe('{"ok":true}');
      expect(response.headers.get("x-inngest-signature")).toBe(
        "response-signature",
      );
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(observed).toMatchObject({
        path: "/api/inngest?fnId=a%2Fb&stepId=x",
        method,
        body: method === "GET" ? "" : raw,
      });
      expect(observed?.headers).toMatchObject({
        host: "demo.example.com",
        "x-inngest-signature": "signature",
        "x-inngest-sync-kind": "in-band",
      });
      for (const header of [
        "cookie",
        "x-customer-id",
        "x-service-secret",
        "authorization",
        "x-forwarded-host",
      ])
        expect(observed?.headers[header]).toBeUndefined();
    },
  );
  it("rejects other methods/suffixes and never exposes ledger business APIs", async () => {
    const paths: string[] = [];
    const app = await setup((req, res) => {
      paths.push(req.url ?? "");
      res.end("agent");
    });
    expect(
      (await app.request("/api/inngest", { method: "DELETE" })).status,
    ).toBe(405);
    expect((await app.request("/api/inngest/events")).status).toBe(404);
    expect(paths).toEqual([]);
    await app.request("/api/events");
    expect(paths).toEqual(["/events"]);
  });
  it("keeps the standalone gateway routing unchanged when disabled", async () => {
    let path = "";
    const app = await setup((req, res) => {
      path = req.url ?? "";
      res.end("agent");
    }, false);
    await app.request("/api/inngest");
    expect(path).toBe("/inngest");
  });
  it("refuses redirects without visiting the location", async () => {
    let count = 0;
    const app = await setup((_req, res) => {
      count++;
      res.writeHead(302, { location: "/internal" });
      res.end();
    });
    expect((await app.request("/api/inngest")).status).toBe(502);
    expect(count).toBe(1);
  });
  it("bounds declared and actual request size", async () => {
    let count = 0;
    const app = await setup((_req, res) => {
      count++;
      res.end();
    });
    expect(
      (
        await app.request("/api/inngest", {
          method: "POST",
          headers: { "content-length": "1048577" },
          body: "x",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request("/api/inngest", {
          method: "POST",
          body: "x".repeat(1048577),
        })
      ).status,
    ).toBe(413);
    expect(count).toBe(0);
  });
  it("bounds response size", async () => {
    const app = await setup((_req, res) => {
      res.end("x".repeat(4194305));
    });
    expect((await app.request("/api/inngest")).status).toBe(502);
  });
  it.each([false, true])(
    "times out upstream headers or a stalled response body (%s)",
    async (headers) => {
      const app = await setup(
        (_req, res) => {
          if (headers) {
            res.writeHead(200);
            res.write("partial");
          }
        },
        true,
        20,
      );
      expect((await app.request("/api/inngest")).status).toBe(504);
    },
  );
  it("keeps browser cookies Secure behind HTTPS proxy routing", async () => {
    const app = await setup((_req, res) => {
      res.end("{}");
    });
    const response = await app.request("http://demo.example.com/api/intents");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
  it("cancels a stalled incoming upload within the callback deadline", async () => {
    let cancelled = false;
    let reached = false;
    const app = await setup(
      (_req, res) => {
        reached = true;
        res.end();
      },
      true,
      20,
    );
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api/inngest", {
      method: "POST",
      body,
      duplex: "half",
    } as unknown as RequestInit);
    expect((await app.request(request)).status).toBe(504);
    expect(cancelled).toBe(true);
    expect(reached).toBe(false);
  });
  it("fails closed if the upstream resets its response stream", async () => {
    const app = await setup((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => {
        res.destroy();
      }, 5);
    });
    expect((await app.request("/api/inngest")).status).toBe(502);
  });
});
