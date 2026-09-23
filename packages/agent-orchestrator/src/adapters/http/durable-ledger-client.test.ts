import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCoreBadRequestError,
  AgentCoreMalformedResponseError,
  AgentCoreNetworkError,
  AgentCoreRequestCanceledError,
  AgentCoreRunNotFoundError,
  AgentCoreTimeoutError,
  AgentCoreUnavailableError,
  AgentCoreUnexpectedResponseError,
} from "../../ports/agent-core-client.js";
import { HttpDurableLedgerClient } from "./durable-ledger-client.js";
import { startFakeDurableLedger } from "./fake-durable-ledger-server.js";

type Server = Awaited<ReturnType<typeof startFakeDurableLedger>>;

let server: Server;

const REQUEST = {
  amount: 4200,
  currency: "USD",
  paymentMethodToken: "tok_visa",
  merchantId: "m_1",
};

describe("HttpDurableLedgerClient — happy paths", () => {
  beforeEach(async () => {
    server = await startFakeDurableLedger();
  });

  afterEach(async () => {
    await server.close();
  });

  it("sends the configured service secret on every durable-ledger request", async () => {
    const serviceSecret = "s".repeat(32);
    const client = new HttpDurableLedgerClient({
      baseUrl: server.baseUrl,
      serviceSecret,
    });

    const { eventId } = await client.startPaymentWorkflow(REQUEST);
    await client.getRunStatus(eventId);

    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.headers["X-Service-Secret"]).toBe(serviceSecret);
    }
  });

  it("startPaymentWorkflow sends POST /workflows/payment, Content-Type json, the exact body, and NO Idempotency-Key header", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await client.startPaymentWorkflow(REQUEST);

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req).toBeDefined();
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/workflows/payment");
    expect(req?.headers["Content-Type"]).toBe("application/json");
    expect(req?.headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(req?.body ?? "{}")).toEqual(REQUEST);
  });

  it("omits the Idempotency-Key header when no key is supplied — the header is opt-in, not automatic", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await client.startPaymentWorkflow(REQUEST, {});

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req?.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("sends Idempotency-Key verbatim when supplied, and never inside the body", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await client.startPaymentWorkflow(REQUEST, {
      idempotencyKey: "intent_abc123",
    });

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0];
    expect(req?.headers["Idempotency-Key"]).toBe("intent_abc123");
    const rawBody = req?.body ?? "{}";
    expect(JSON.parse(rawBody)).toEqual(REQUEST);
    expect(rawBody).not.toContain("intent_abc123");
  });

  it("a blank (whitespace-only) idempotencyKey throws AgentCoreBadRequestError before any request is sent", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(
      client.startPaymentWorkflow(REQUEST, { idempotencyKey: "   " }),
    ).rejects.toBeInstanceOf(AgentCoreBadRequestError);
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ["a control character", `bad\tkey`],
    ["a 201-character string", "a".repeat(201)],
    ["a non-ASCII character", "clé_intent_1"],
  ])(
    "a shape-violating idempotencyKey (%s) throws AgentCoreBadRequestError before any request is sent",
    async (_label, key) => {
      const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
      await expect(
        client.startPaymentWorkflow(REQUEST, { idempotencyKey: key }),
      ).rejects.toBeInstanceOf(AgentCoreBadRequestError);
      expect(server.requests).toHaveLength(0);
    },
  );

  it("a shape-violating idempotencyKey's error message never contains the key value itself", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const sentinelKey = "bad\tkey_sentinel_99999";
    await expect(
      client.startPaymentWorkflow(REQUEST, { idempotencyKey: sentinelKey }),
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).not.toContain(sentinelKey);
      expect(JSON.stringify(err)).not.toContain(sentinelKey);
      return true;
    });
  });

  it("a 202 resolves to {eventId} only — statusUrl does not leak onto the result", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const result = await client.startPaymentWorkflow(REQUEST);

    expect(Object.keys(result)).toEqual(["eventId"]);
    expect(typeof result.eventId).toBe("string");
    expect(result.eventId.length).toBeGreaterThan(0);
  });

  it("getRunStatus sends GET /workflows/:eventId, no body, no Content-Type", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const { eventId } = await client.startPaymentWorkflow(REQUEST);
    await client.getRunStatus(eventId);

    const getReq = server.requests.find((r) => r.method === "GET");
    expect(getReq).toBeDefined();
    expect(getReq?.path).toBe(`/workflows/${eventId}`);
    expect(getReq?.body).toBe("");
    expect(getReq?.headers["Content-Type"]).toBeUndefined();
  });

  it("a queued snapshot round-trips with nulls preserved, not coerced to undefined", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const { eventId } = await client.startPaymentWorkflow(REQUEST);
    const snapshot = await client.getRunStatus(eventId);

    expect(snapshot).toEqual({
      eventId,
      runId: null,
      status: "queued",
      startedAt: null,
      endedAt: null,
      needsReview: false,
      failureMessage: null,
    });
    expect(snapshot.runId).toBeNull();
    expect(snapshot.startedAt).toBeNull();
  });

  it("a failed + needsReview:true snapshot round-trips with failureMessage intact", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const { eventId } = await client.startPaymentWorkflow(REQUEST);
    const record = server.runs.get(eventId);
    expect(record).toBeDefined();
    if (record !== undefined) {
      record.runId = "run_123";
      record.status = "failed";
      record.startedAt = "2026-09-14T10:00:00.000Z";
      record.endedAt = "2026-09-14T10:05:00.000Z";
      record.needsReview = true;
      record.failureMessage = "provider declined after 3 attempts";
    }

    const snapshot = await client.getRunStatus(eventId);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.needsReview).toBe(true);
    expect(snapshot.failureMessage).toBe("provider declined after 3 attempts");
    expect(typeof snapshot.startedAt).toBe("string");
    expect(typeof snapshot.endedAt).toBe("string");
  });

  it("timestamps stay strings, never parsed to Date", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const { eventId } = await client.startPaymentWorkflow(REQUEST);
    const record = server.runs.get(eventId);
    if (record !== undefined) {
      record.startedAt = "2026-09-14T10:00:00.000Z";
    }
    const snapshot = await client.getRunStatus(eventId);
    expect(typeof snapshot.startedAt).toBe("string");
    expect(() => new Date(snapshot.startedAt ?? "")).not.toThrow();
  });

  it("baseUrl with a trailing slash is tolerated", async () => {
    const client = new HttpDurableLedgerClient({
      baseUrl: `${server.baseUrl}/`,
    });
    const result = await client.startPaymentWorkflow(REQUEST);
    expect(typeof result.eventId).toBe("string");
    expect(server.requests[0]?.path).toBe("/workflows/payment");
  });

  it("baseUrl with a path prefix is preserved", async () => {
    const prefixed = await startFakeDurableLedger();
    try {
      const client = new HttpDurableLedgerClient({
        baseUrl: `${prefixed.baseUrl}/api`,
      });
      await expect(client.startPaymentWorkflow(REQUEST)).rejects.toBeInstanceOf(
        AgentCoreUnexpectedResponseError,
      );
      expect(prefixed.requests[0]?.path).toBe("/api/workflows/payment");
    } finally {
      await prefixed.close();
    }
  });

  it("an eventId containing '/' arrives percent-encoded as one segment", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const weirdId = "abc/def";
    await expect(client.getRunStatus(weirdId)).rejects.toBeInstanceOf(
      AgentCoreRunNotFoundError,
    );
    const getReq = server.requests.find((r) => r.method === "GET");
    expect(getReq?.path).toBe(`/workflows/${encodeURIComponent(weirdId)}`);
  });

  it("calling startPaymentWorkflow twice with an identical request and NO idempotencyKey produces two distinct event ids and two recorded requests — with no key supplied, the wire call itself is not idempotent; exactly-once for a real ApproveIntent call is layered on via Intent.approve plus a caller-supplied idempotencyKey (ADR-0013)", async () => {
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const first = await client.startPaymentWorkflow(REQUEST);
    const second = await client.startPaymentWorkflow(REQUEST);

    expect(first.eventId).not.toBe(second.eventId);
    const postRequests = server.requests.filter(
      (r) => r.method === "POST" && r.path === "/workflows/payment",
    );
    expect(postRequests).toHaveLength(2);
  });
});

describe("HttpDurableLedgerClient — error classification against the fake wire", () => {
  afterEach(async () => {
    await server.close();
  });

  it("400 validation_failed with details -> AgentCoreBadRequestError", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "validation_failed",
              message: "Request validation failed",
              details: [{ path: "amount", message: "Required" }],
            },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreBadRequestError);
        expect((err as AgentCoreBadRequestError).details).toEqual([
          { path: "amount", message: "Required" },
        ]);
        expect((err as AgentCoreBadRequestError).retryable).toBe(false);
        return true;
      },
    );
  });

  it("400 invalid_json -> AgentCoreBadRequestError", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "invalid_json",
              message: "Request body is not valid JSON",
            },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toBeInstanceOf(
      AgentCoreBadRequestError,
    );
  });

  it("404 workflow_run_not_found on GET -> AgentCoreRunNotFoundError, not retryable", async () => {
    server = await startFakeDurableLedger();
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.getRunStatus("unknown-id")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreRunNotFoundError);
        expect((err as AgentCoreRunNotFoundError).retryable).toBe(false);
        return true;
      },
    );
  });

  it("a bare 404 not_found on GET -> AgentCoreUnexpectedResponseError, NOT AgentCoreRunNotFoundError (deliberate divergence)", async () => {
    server = await startFakeDurableLedger({
      getRunStatus(_ctx, res) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "not_found", message: "Not found" },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.getRunStatus("anything")).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreUnexpectedResponseError);
        expect(err).not.toBeInstanceOf(AgentCoreRunNotFoundError);
        return true;
      },
    );
  });

  it("a 404 on POST /workflows/payment -> AgentCoreUnexpectedResponseError regardless of body", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "workflow_run_not_found",
              message: "No workflow run found",
            },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toBeInstanceOf(
      AgentCoreUnexpectedResponseError,
    );
  });

  it("503 workflow_engine_unavailable -> AgentCoreUnavailableError, retryable, no retryAfterMs property", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "workflow_engine_unavailable",
              message: "Inngest unreachable",
            },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreUnavailableError);
        expect((err as AgentCoreUnavailableError).retryable).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(err, "retryAfterMs")).toBe(
          false,
        );
        return true;
      },
    );
  });

  it("500 internal_error -> AgentCoreUnexpectedResponseError, retryable", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "internal_error", message: "Internal server error" },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreUnexpectedResponseError);
        expect((err as AgentCoreUnexpectedResponseError).retryable).toBe(true);
        return true;
      },
    );
  });

  it("a 500 with an HTML body classifies without throwing during parsing", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<html><body>Internal Server Error</body></html>");
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreUnexpectedResponseError);
        expect((err as AgentCoreUnexpectedResponseError).retryable).toBe(true);
        return true;
      },
    );
  });

  it("a 200 missing a required field (eventId) -> AgentCoreMalformedResponseError", async () => {
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ statusUrl: "/workflows/abc" }));
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(client.startPaymentWorkflow(REQUEST)).rejects.toBeInstanceOf(
      AgentCoreMalformedResponseError,
    );
  });

  it("a 200 with an unknown status string ('succeeded') -> AgentCoreMalformedResponseError, proving the z.enum guard works", async () => {
    server = await startFakeDurableLedger({
      getRunStatus(_ctx, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            runId: null,
            status: "succeeded",
            startedAt: null,
            endedAt: null,
            needsReview: false,
            failureMessage: null,
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(
      client.getRunStatus("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ).rejects.toBeInstanceOf(AgentCoreMalformedResponseError);
  });

  it("connection refused -> AgentCoreNetworkError, retryable", async () => {
    server = await startFakeDurableLedger();
    const client = new HttpDurableLedgerClient({
      baseUrl: "http://127.0.0.1:1",
    });
    await expect(client.getRunStatus("x")).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AgentCoreNetworkError);
      expect((err as AgentCoreNetworkError).retryable).toBe(true);
      return true;
    });
  });

  it("a delayed response + short timeoutMs rejects PROMPTLY with AgentCoreTimeoutError carrying timeoutMs", async () => {
    server = await startFakeDurableLedger({
      getRunStatus(_ctx, res) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, 500);
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const start = Date.now();
    await expect(client.getRunStatus("x", { timeoutMs: 20 })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(AgentCoreTimeoutError);
        expect((err as AgentCoreTimeoutError).retryable).toBe(true);
        expect((err as AgentCoreTimeoutError).timeoutMs).toBe(20);
        return true;
      },
    );
    expect(Date.now() - start).toBeLessThan(300);
  });

  it("a caller AbortSignal aborted mid-flight -> AgentCoreRequestCanceledError, distinguishable from a timeout", async () => {
    server = await startFakeDurableLedger({
      getRunStatus(_ctx, res) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, 500);
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    const controller = new AbortController();
    const promise = client.getRunStatus("x", {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AgentCoreRequestCanceledError);
      expect(err).not.toBeInstanceOf(AgentCoreTimeoutError);
      expect((err as AgentCoreRequestCanceledError).retryable).toBe(false);
      return true;
    });
  });

  it("a per-call timeoutMs overrides the constructor default", async () => {
    server = await startFakeDurableLedger({
      getRunStatus(_ctx, res) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }, 500);
      },
    });
    const client = new HttpDurableLedgerClient({
      baseUrl: server.baseUrl,
      timeoutMs: 60_000,
    });
    const start = Date.now();
    await expect(
      client.getRunStatus("x", { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(AgentCoreTimeoutError);
    expect(Date.now() - start).toBeLessThan(300);
  });

  it("security pin: a sentinel paymentMethodToken never appears in a 400 error's message or JSON.stringify", async () => {
    const sentinel = "tok_super_secret_pm_99999";
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "validation_failed",
              message: "Request validation failed",
            },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(
      client.startPaymentWorkflow({ ...REQUEST, paymentMethodToken: sentinel }),
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).not.toContain(sentinel);
      expect(JSON.stringify(err)).not.toContain(sentinel);
      return true;
    });
  });

  it("security pin: a sentinel paymentMethodToken never appears in a 503 error's message or JSON.stringify", async () => {
    const sentinel = "tok_super_secret_pm_88888";
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "workflow_engine_unavailable",
              message: "Inngest unreachable",
            },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(
      client.startPaymentWorkflow({ ...REQUEST, paymentMethodToken: sentinel }),
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).not.toContain(sentinel);
      expect(JSON.stringify(err)).not.toContain(sentinel);
      return true;
    });
  });

  it("security pin: a sentinel paymentMethodToken never appears in a 500 error's message or JSON.stringify", async () => {
    const sentinel = "tok_super_secret_pm_77777";
    server = await startFakeDurableLedger({
      startPaymentWorkflow(_ctx, res) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: "internal_error", message: "Internal server error" },
          }),
        );
      },
    });
    const client = new HttpDurableLedgerClient({ baseUrl: server.baseUrl });
    await expect(
      client.startPaymentWorkflow({ ...REQUEST, paymentMethodToken: sentinel }),
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).not.toContain(sentinel);
      expect(JSON.stringify(err)).not.toContain(sentinel);
      return true;
    });
  });
});
