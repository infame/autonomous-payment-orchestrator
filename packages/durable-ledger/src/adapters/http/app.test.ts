import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createInMemoryDurableLedger } from "../../composition-root.js";
import { FakePayCoreClient } from "../../workflow/fake-pay-core-client.js";
import { FakeWorkflowRuns } from "./fake-workflow-runs.js";
import { PostingGroup } from "../../domain/entry.js";
import { Money } from "../../domain/money.js";
import type { InMemoryLedgerRepository } from "../memory/in-memory-ledger-repository.js";
import { WorkflowEngineUnavailableError } from "../../ports/workflow-runs.js";
import type { WorkflowRunSnapshot } from "../../ports/workflow-runs.js";
import { createLedgerApp } from "./app.js";

const VALID_EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TEST_SERVICE_SECRET = "test-durable-ledger-service-secret";

function authenticatedTestApp(app: Hono, serviceSecret: string): Hono {
  const authenticated = new Hono();
  authenticated.all("*", (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Service-Secret", serviceSecret);
    return app.fetch(new Request(c.req.raw, { headers }));
  });
  return authenticated;
}

function buildApp(serviceSecret = TEST_SERVICE_SECRET): {
  app: Hono;
  rawApp: Hono;
  ledger: InMemoryLedgerRepository;
  runs: FakeWorkflowRuns;
} {
  const runs = new FakeWorkflowRuns();
  const { app: rawApp, ledger } = createInMemoryDurableLedger({
    payCore: new FakePayCoreClient(),
    runs,
    serviceSecret,
  });
  return {
    app: authenticatedTestApp(rawApp, serviceSecret),
    rawApp,
    ledger,
    runs,
  };
}

const PAYMENT_EXECUTE_BODY = {
  amount: 2000,
  currency: "USD",
  paymentMethodToken: "tok_visa",
  merchantId: "merchant_1",
};

describe("createLedgerApp", () => {
  describe("service-to-service authentication", () => {
    const serviceSecret = "s".repeat(32);

    it.each([
      ["POST", "/workflows/payment"],
      ["GET", `/workflows/${VALID_EVENT_ID}`],
      ["GET", `/ledger/entries?paymentId=${randomUUID()}`],
      ["GET", "/ledger/accounts/acquirer_clearing/balance?currency=USD"],
    ])("hides %s %s without the service secret", async (method, path) => {
      const { rawApp, runs } = buildApp(serviceSecret);
      const res = await rawApp.request(path, {
        method,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(PAYMENT_EXECUTE_BODY),
            }
          : {}),
      });

      expect(res.status).toBe(404);
      expect(runs.startCalls).toHaveLength(0);
    });

    it("accepts a matching secret on a business route", async () => {
      const { rawApp, runs } = buildApp(serviceSecret);
      const res = await rawApp.request("/workflows/payment", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Secret": serviceSecret,
        },
        body: JSON.stringify(PAYMENT_EXECUTE_BODY),
      });

      expect(res.status).toBe(202);
      expect(runs.startCalls).toHaveLength(1);
    });

    it("rejects a wrong same-length secret without touching the workflow port", async () => {
      const { rawApp, runs } = buildApp(serviceSecret);
      const res = await rawApp.request("/workflows/payment", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Secret": "x".repeat(32),
        },
        body: JSON.stringify(PAYMENT_EXECUTE_BODY),
      });

      expect(res.status).toBe(404);
      expect(runs.startCalls).toHaveLength(0);
    });

    it("keeps health and the Inngest callback outside business-route auth", async () => {
      const { ledger, runs } = buildApp();
      const app = createLedgerApp({
        ledger,
        runs,
        serviceSecret,
        inngestHandler: async (c) => c.json({ callback: "reachable" }),
      });

      expect((await app.request("/healthz")).status).toBe(200);
      const callback = await app.request("/api/inngest", { method: "POST" });
      expect(callback.status).toBe(200);
      expect(await callback.json()).toEqual({ callback: "reachable" });
    });

    it("fails closed when a public app is constructed with an invalid secret", () => {
      const { ledger, runs } = buildApp();

      expect(() =>
        createLedgerApp({ ledger, runs, serviceSecret: "too-short" }),
      ).toThrow("serviceSecret must contain at least 32 characters");
    });

    it("fails closed when the exported in-memory factory receives an invalid secret", () => {
      expect(() =>
        createInMemoryDurableLedger({
          payCore: new FakePayCoreClient(),
          runs: new FakeWorkflowRuns(),
          serviceSecret: "too-short",
        }),
      ).toThrow("serviceSecret must contain at least 32 characters");
    });
  });

  describe("GET /healthz", () => {
    it("returns 200 with a static ok body", async () => {
      const { app } = buildApp();
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("POST /workflows/payment", () => {
    it("starts a run and returns 202 with an eventId and statusUrl", async () => {
      const { app, runs } = buildApp();
      const res = await app.request("/workflows/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PAYMENT_EXECUTE_BODY),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        eventId: string;
        statusUrl: string;
      };
      expect(body.statusUrl).toBe(`/workflows/${body.eventId}`);
      expect(runs.startCalls).toHaveLength(1);
      expect(runs.startCalls[0]).toEqual(PAYMENT_EXECUTE_BODY);
    });

    it("returns 400 validation_failed for a missing field", async () => {
      const { app } = buildApp();
      const res = await app.request("/workflows/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 2000, currency: "USD" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns 400 invalid_json for a malformed body", async () => {
      const { app } = buildApp();
      const res = await app.request("/workflows/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_json");
    });

    it("forwards the Idempotency-Key header to the port", async () => {
      const { app, runs } = buildApp();
      const key = "intent-abc-123";
      const res = await app.request("/workflows/payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(PAYMENT_EXECUTE_BODY),
      });
      expect(res.status).toBe(202);
      expect(runs.startKeys[0]).toBe(key);
      expect(runs.startCalls[0]).toEqual(PAYMENT_EXECUTE_BODY);
    });

    it("calls the port with no key when the header is absent", async () => {
      const { app, runs } = buildApp();
      const res = await app.request("/workflows/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PAYMENT_EXECUTE_BODY),
      });
      expect(res.status).toBe(202);
      expect(runs.startKeys[0]).toBeUndefined();
    });

    it.each([
      ["a blank string", ""],
      ["a string containing a space", "has a space"],
      ["a 201-character string", "a".repeat(201)],
      ["a string containing a control character", "bad\x01key"],
    ])(
      "returns 400 validation_failed for %s and never calls the port",
      async (_label, key) => {
        const { app, runs } = buildApp();
        const res = await app.request("/workflows/payment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(PAYMENT_EXECUTE_BODY),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("validation_failed");
        expect(runs.startCalls).toHaveLength(0);
        expect(runs.startKeys).toHaveLength(0);
      },
    );

    it("the 202 response shape is unchanged when a key is supplied", async () => {
      const { app } = buildApp();
      const res = await app.request("/workflows/payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "intent-abc-123",
        },
        body: JSON.stringify(PAYMENT_EXECUTE_BODY),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["eventId", "statusUrl"]);
      expect(body.statusUrl).toBe(`/workflows/${body.eventId as string}`);
    });
  });

  describe("GET /workflows/:eventId", () => {
    it("returns 400 validation_failed for a badly-formatted event id", async () => {
      const { app } = buildApp();
      const res = await app.request("/workflows/not-a-valid-id");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns 404 workflow_run_not_found for an unknown (but well-formed) event id", async () => {
      const { app } = buildApp();
      const res = await app.request(`/workflows/${VALID_EVENT_ID}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("workflow_run_not_found");
    });

    const baseSnapshot = {
      eventId: VALID_EVENT_ID,
      runId: "run_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      needsReview: false,
      failureMessage: null,
    };

    it.each([
      ["queued", { ...baseSnapshot, status: "queued", runId: null } as const],
      ["running", { ...baseSnapshot, status: "running" } as const],
      [
        "completed",
        {
          ...baseSnapshot,
          status: "completed",
          endedAt: "2026-01-01T00:01:00.000Z",
        } as const,
      ],
      [
        "cancelled",
        {
          ...baseSnapshot,
          status: "cancelled",
          endedAt: "2026-01-01T00:01:00.000Z",
        } as const,
      ],
    ] as const)("returns 200 for a %s run", async (_label, snapshot) => {
      const { app, runs } = buildApp();
      runs.script(VALID_EVENT_ID, snapshot);

      const res = await app.request(`/workflows/${VALID_EVENT_ID}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(snapshot);
    });

    it("returns 200 for a failed run with needsReview: true", async () => {
      const { app, runs } = buildApp();
      const snapshot: WorkflowRunSnapshot = {
        ...baseSnapshot,
        status: "failed",
        endedAt: "2026-01-01T00:01:00.000Z",
        needsReview: true,
        failureMessage: "payment.execute needs_review: ...",
      };
      runs.script(VALID_EVENT_ID, snapshot);

      const res = await app.request(`/workflows/${VALID_EVENT_ID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkflowRunSnapshot;
      expect(body.status).toBe("failed");
      expect(body.needsReview).toBe(true);
    });

    it("returns 200 for a failed run with needsReview: false", async () => {
      const { app, runs } = buildApp();
      const snapshot: WorkflowRunSnapshot = {
        ...baseSnapshot,
        status: "failed",
        endedAt: "2026-01-01T00:01:00.000Z",
        needsReview: false,
        failureMessage: "payment.execute failed at step ... compensated: ...",
      };
      runs.script(VALID_EVENT_ID, snapshot);

      const res = await app.request(`/workflows/${VALID_EVENT_ID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkflowRunSnapshot;
      expect(body.status).toBe("failed");
      expect(body.needsReview).toBe(false);
    });

    it("returns 503 workflow_engine_unavailable when the engine can't be reached", async () => {
      const { app, runs } = buildApp();
      runs.script(
        VALID_EVENT_ID,
        new WorkflowEngineUnavailableError("Inngest is unreachable"),
      );

      const res = await app.request(`/workflows/${VALID_EVENT_ID}`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("workflow_engine_unavailable");
    });
  });

  describe("GET /ledger/entries", () => {
    async function seedCapture(
      ledger: InMemoryLedgerRepository,
      overrides: {
        paymentId?: string;
        merchantId?: string;
        amount?: number;
      } = {},
    ): Promise<{ operationId: string; paymentId: string }> {
      const operationId = randomUUID();
      const paymentId = overrides.paymentId ?? `pay_${randomUUID()}`;
      const group = PostingGroup.forCapture({
        operationId,
        paymentId,
        merchantId: overrides.merchantId ?? "merchant_1",
        amount: Money.of(overrides.amount ?? 1000, "USD"),
      });
      await ledger.post(group);
      return { operationId, paymentId };
    }

    it("filters by paymentId", async () => {
      const { app, ledger } = buildApp();
      const { paymentId } = await seedCapture(ledger);

      const res = await app.request(`/ledger/entries?paymentId=${paymentId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: { paymentId: string }[] };
      expect(body.entries).toHaveLength(2);
      expect(body.entries.every((e) => e.paymentId === paymentId)).toBe(true);
    });

    it("filters by operationId", async () => {
      const { app, ledger } = buildApp();
      const { operationId } = await seedCapture(ledger);

      const res = await app.request(
        `/ledger/entries?operationId=${operationId}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: { operationId: string }[];
      };
      expect(body.entries).toHaveLength(2);
      expect(body.entries.every((e) => e.operationId === operationId)).toBe(
        true,
      );
    });

    it("returns 400 validation_failed when both filters are provided", async () => {
      const { app, ledger } = buildApp();
      const { operationId, paymentId } = await seedCapture(ledger);

      const res = await app.request(
        `/ledger/entries?operationId=${operationId}&paymentId=${paymentId}`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns 400 validation_failed when neither filter is provided", async () => {
      const { app } = buildApp();
      const res = await app.request("/ledger/entries");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns 200 with an empty array for a paymentId with no entries (not 404)", async () => {
      const { app } = buildApp();
      const res = await app.request(
        `/ledger/entries?paymentId=${randomUUID()}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ entries: [] });
    });
  });

  describe("GET /ledger/accounts/:account/balance", () => {
    it("returns the merchant's positive balance after a capture", async () => {
      const { app, ledger } = buildApp();
      const merchantId = `m_${randomUUID()}`;
      await ledger.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: `pay_${randomUUID()}`,
          merchantId,
          amount: Money.of(1500, "USD"),
        }),
      );

      const res = await app.request(
        `/ledger/accounts/${encodeURIComponent(`merchant:${merchantId}`)}/balance?currency=USD`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        account: string;
        currency: string;
        balance: { amount: number; currency: string };
      };
      expect(body.account).toBe(`merchant:${merchantId}`);
      expect(body.balance).toEqual({ amount: 1500, currency: "USD" });
    });

    it("returns the acquirer_clearing account's negative balance, pinning the sign convention at the HTTP boundary", async () => {
      const { app, ledger } = buildApp();
      await ledger.post(
        PostingGroup.forCapture({
          operationId: randomUUID(),
          paymentId: `pay_${randomUUID()}`,
          merchantId: `m_${randomUUID()}`,
          amount: Money.of(750, "USD"),
        }),
      );

      const res = await app.request(
        `/ledger/accounts/${encodeURIComponent("acquirer_clearing")}/balance?currency=USD`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        balance: { amount: number; currency: string };
      };
      expect(body.balance.amount).toBeLessThan(0);
    });

    it("returns 400 validation_failed for a malformed account string", async () => {
      const { app } = buildApp();
      const res = await app.request(
        "/ledger/accounts/not-a-valid-account/balance?currency=USD",
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_account");
    });

    it("returns 400 validation_failed for a bad currency", async () => {
      const { app } = buildApp();
      const res = await app.request(
        `/ledger/accounts/${encodeURIComponent("acquirer_clearing")}/balance?currency=usd`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns 400 validation_failed when currency is missing", async () => {
      const { app } = buildApp();
      const res = await app.request(
        `/ledger/accounts/${encodeURIComponent("acquirer_clearing")}/balance`,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    });
  });

  describe("app.notFound", () => {
    it("returns a JSON error envelope for an unknown route", async () => {
      const { app } = buildApp();
      const res = await app.request("/some/nonexistent/route");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    });
  });
});
