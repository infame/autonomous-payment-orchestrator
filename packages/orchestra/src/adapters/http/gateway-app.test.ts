import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayApp, type GatewayAppDeps } from "./gateway-app.js";
import {
  InMemoryGrantStore,
  InMemoryLiveBudgetStore,
} from "../../test-support/adapters/in-memory-grant-store.js";
import {
  startScriptedServer,
  type ScriptedRoute,
  type ScriptedServer,
} from "../../test-support/scripted-http-server.js";
import { signGrant, verifyGrant } from "../../grant/token.js";

const ADMIN_SECRET = "a".repeat(32);
const GRANT_SIGNING_KEY = "k".repeat(32);
const SUBMISSION_KEY = "5c56582f-6ebe-4a3c-ad64-77d884875c29";
const PUBLIC_BASE_URL = "http://localhost:3300";

const openServers: ScriptedServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

const OK_JSON: ScriptedRoute["respond"] = { status: 200, body: { ok: true } };

function chunkedPostRequest(
  path: string,
  chunks: readonly Uint8Array[],
  headers: Readonly<Record<string, string>>,
  onCancel: () => void,
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
    },
  });
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as unknown as RequestInit & { duplex: "half" });
}

async function startFakeUpstream(
  routes: ScriptedRoute[] = [],
): Promise<ScriptedServer> {
  const server = await startScriptedServer([
    ...routes,
    // A permissive catch-all so tests that don't care about the exact
    // upstream response still get a 200, not an unscripted-404 that would
    // masquerade as a real assertion failure.
    { method: "GET", path: /.*/, respond: OK_JSON, repeat: true },
    { method: "POST", path: /.*/, respond: OK_JSON, repeat: true },
  ]);
  openServers.push(server);
  return server;
}

interface TestSetup {
  readonly app: ReturnType<typeof createGatewayApp>;
  readonly grantStore: InMemoryGrantStore;
  readonly liveBudgetStore: InMemoryLiveBudgetStore;
  readonly mockUpstream: ScriptedServer;
  readonly liveUpstream: ScriptedServer;
  readonly now: Date;
}

async function setup(
  overrides: Partial<GatewayAppDeps> = {},
  mockRoutes: ScriptedRoute[] = [],
  liveRoutes: ScriptedRoute[] = [],
): Promise<TestSetup> {
  const mockUpstream = await startFakeUpstream(mockRoutes);
  const liveUpstream = await startFakeUpstream(liveRoutes);
  const now = new Date("2026-01-01T00:00:00.000Z");
  // `InMemoryGrantStore` is given the SAME fixed clock the gateway app
  // itself uses below — otherwise `create()`'s real-wall-clock `issuedAt`
  // would race ahead of this fictional, fixed `now` and trip the
  // `expiresAt > issuedAt` invariant (see the store's own constructor doc).
  const grantStore = new InMemoryGrantStore(() => now);
  const liveBudgetStore = new InMemoryLiveBudgetStore();

  const app = createGatewayApp({
    grantStore,
    liveBudgetStore,
    adminSecret: ADMIN_SECRET,
    grantSigningKey: GRANT_SIGNING_KEY,
    publicBaseUrl: PUBLIC_BASE_URL,
    agentOrchestratorUrl: mockUpstream.baseUrl,
    agentOrchestratorLiveUrl: liveUpstream.baseUrl,
    grantDefaultTtlSeconds: 86_400,
    grantDefaultMaxCalls: 20,
    liveCallsPerDay: 200,
    clock: () => now,
    ...overrides,
  });

  return { app, grantStore, liveBudgetStore, mockUpstream, liveUpstream, now };
}

/**
 * Mints a grant AND binds it to a session, then returns a ready-to-use
 * `Cookie` header value carrying BOTH `apo_grant` (the signed token) and
 * `apo_grant_session` (the marker `bindSession` wrote to
 * `bound_session_id`) — `resolveUpstream` requires both to match before
 * ever routing to the live upstream (see `gateway-app.ts`'s
 * `GRANT_SESSION_COOKIE` header), so a test presenting only `apo_grant`
 * exercises the "bearer token alone is not enough" case on purpose, not by
 * omission.
 */
async function mintAndBindGrant(
  grantStore: InMemoryGrantStore,
  now: Date,
  options: { maxCalls?: number; ttlSeconds?: number } = {},
): Promise<{ jti: string; token: string; cookieHeader: string }> {
  const jti = randomUUID();
  const maxCalls = options.maxCalls ?? 5;
  const expiresAt = new Date(
    now.getTime() + (options.ttlSeconds ?? 3600) * 1000,
  );
  await grantStore.create({ jti, expiresAt, maxCalls });
  const token = signGrant(
    { jti, exp: Math.floor(expiresAt.getTime() / 1000), maxCalls },
    GRANT_SIGNING_KEY,
  );
  const sessionMarker = "test-session";
  const bound = await grantStore.bindSession(jti, sessionMarker, now);
  if (bound === null) {
    throw new Error("test setup: bindSession unexpectedly refused");
  }
  return {
    jti,
    token,
    cookieHeader: `apo_grant=${token}; apo_grant_session=${sessionMarker}`,
  };
}

describe("POST /internal/grant", () => {
  it("404s when X-Admin-Secret is missing", async () => {
    const { app } = await setup();
    const res = await app.request("/internal/grant", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("404s when X-Admin-Secret is wrong", async () => {
    const { app } = await setup();
    const res = await app.request("/internal/grant", {
      method: "POST",
      headers: { "X-Admin-Secret": "wrong-secret-wrong-secret-wrong" },
    });
    expect(res.status).toBe(404);
  });

  it("issues a verifiable grant URL with the right secret", async () => {
    const { app } = await setup();
    const res = await app.request("/internal/grant", {
      method: "POST",
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string };
    expect(body.url.startsWith(`${PUBLIC_BASE_URL}/grant/`)).toBe(true);
    const token = body.url.slice(`${PUBLIC_BASE_URL}/grant/`.length);
    const claims = verifyGrant(
      token,
      GRANT_SIGNING_KEY,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(claims.maxCalls).toBe(20);
  });

  it("400s on malformed JSON, not 500", async () => {
    const { app } = await setup();
    const res = await app.request("/internal/grant", {
      method: "POST",
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        "content-type": "application/json",
      },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
  });

  it("413s a body over the size cap, checked against a declared Content-Length", async () => {
    const { app } = await setup();
    const oversized = JSON.stringify({
      ttlSeconds: 60,
      padding: "x".repeat(5_000),
    });
    const res = await app.request("/internal/grant", {
      method: "POST",
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(oversized, "utf8")),
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("413s a body over the size cap even without a Content-Length header while streaming", async () => {
    const { app } = await setup();
    const oversized = JSON.stringify({
      ttlSeconds: 60,
      padding: "x".repeat(5_000),
    });
    const res = await app.request("/internal/grant", {
      method: "POST",
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        "content-type": "application/json",
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });
});

describe("GET /grant/:token", () => {
  it("sets a cookie with all four flags and redirects home", async () => {
    const { app } = await setup();
    const grantRes = await app.request("/internal/grant", {
      method: "POST",
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const { url } = (await grantRes.json()) as { url: string };
    const token = url.slice(`${PUBLIC_BASE_URL}/grant/`.length);

    const res = await app.request(`/grant/${token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("apo_grant=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    const grantCookies = res.headers
      .getSetCookie()
      .filter(
        (value) =>
          value.startsWith("apo_grant=") ||
          value.startsWith("apo_grant_session="),
      );
    expect(grantCookies).toHaveLength(2);
    for (const cookie of grantCookies)
      expect(cookie).toMatch(/;\s*Secure(?:;|$)/);
  });

  it("404s for a second browser opening an already-bound grant link", async () => {
    const { app } = await setup();
    const grantRes = await app.request("/internal/grant", {
      method: "POST",
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const { url } = (await grantRes.json()) as { url: string };
    const token = url.slice(`${PUBLIC_BASE_URL}/grant/`.length);

    const first = await app.request(`/grant/${token}`, { redirect: "manual" });
    expect(first.status).toBe(302);

    const second = await app.request(`/grant/${token}`, { redirect: "manual" });
    expect(second.status).toBe(404);
  });

  it("404s for a malformed or unsigned token", async () => {
    const { app } = await setup();
    const res = await app.request("/grant/not-a-real-token", {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });
});

describe("browser UI actions", () => {
  it("submits form text through /api, redirects with 303, and keeps a freshly minted customer cookie continuous", async () => {
    const { app, mockUpstream } = await setup({}, [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: { status: 201, body: { intent: { id: "intent-created" } } },
      },
    ]);

    const res = await app.request("/ui/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        text: "Pay the vendor.",
        submissionKey: SUBMISSION_KEY,
      }).toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/intents/intent-created");
    expect(mockUpstream.requests).toHaveLength(1);
    expect(mockUpstream.requests[0]?.body).toEqual({ text: "Pay the vendor." });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const mintedCustomerId = /apo_customer_id=([^;]+)/.exec(setCookie)?.[1];
    expect(mintedCustomerId).toBeDefined();
    expect(mockUpstream.requests[0]?.headers["x-customer-id"]).toBe(
      mintedCustomerId,
    );
  });

  it("translates the clarification form to the real { answer } JSON wire shape", async () => {
    const { app, mockUpstream } = await setup({}, [
      {
        method: "POST",
        path: /^\/intents\/intent-1\/clarify$/,
        respond: { status: 200, body: { intent: { id: "intent-1" } } },
      },
    ]);

    const res = await app.request("/ui/intents/intent-1/clarify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        answer: "Use the invoice total.",
      }).toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/intents/intent-1");
    expect(mockUpstream.requests[0]?.body).toEqual({
      answer: "Use the invoice total.",
    });
  });

  it.each(["approve", "reject"] as const)(
    "%s delegates to the matching bodyless API action and redirects to detail",
    async (action) => {
      const { app, mockUpstream } = await setup({}, [
        {
          method: "POST",
          path: new RegExp(`^/intents/intent-2/${action}$`),
          respond: { status: 200, body: { intent: { id: "intent-2" } } },
        },
      ]);

      const res = await app.request(`/ui/intents/intent-2/${action}`, {
        method: "POST",
        redirect: "manual",
      });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/intents/intent-2");
      expect(mockUpstream.requests).toHaveLength(1);
      expect(mockUpstream.requests[0]?.body).toBeUndefined();
    },
  );

  it("preserves live grant routing and charges the budget on a UI submit", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup(
      {},
      [],
      [
        {
          method: "POST",
          path: /^\/intents$/,
          respond: { status: 201, body: { intent: { id: "live-intent" } } },
        },
      ],
    );
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now);

    const res = await app.request("/ui/intents", {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        text: "Pay the vendor.",
        submissionKey: SUBMISSION_KEY,
      }).toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(303);
    expect(liveUpstream.requests).toHaveLength(1);
    expect(mockUpstream.requests).toHaveLength(0);
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(1);
  });

  it("returns the upstream failure status in escaped HTML", async () => {
    const { app } = await setup({}, [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: {
          status: 422,
          body: {
            error: {
              code: "invalid_intent",
              message: '<script>alert("upstream")</script>',
            },
          },
        },
      },
    ]);

    const res = await app.request("/ui/intents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        text: "bad intent",
        submissionKey: SUBMISSION_KEY,
      }).toString(),
    });
    const body = await res.text();

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
  });

  it("cancels a chunked form upload over 64 KiB before API dispatch or live-budget claim", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now);
    let canceled = false;
    const request = chunkedPostRequest(
      "/ui/intents",
      [
        new TextEncoder().encode(`text=${"a".repeat(40_000)}`),
        new TextEncoder().encode("b".repeat(30_000)),
        new TextEncoder().encode("must-not-be-read"),
      ],
      {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
      },
      () => {
        canceled = true;
      },
    );

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    expect(canceled).toBe(true);
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("rejects a declared form body over 64 KiB before reading or dispatching", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now);

    const res = await app.request("/ui/intents", {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(64 * 1_024 + 1),
      },
      body: "text=small",
    });

    expect(res.status).toBe(413);
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
  });
});

describe("GET /intents/:id upstream response boundary", () => {
  it("returns a stable 502 when a successful upstream response is malformed JSON", async () => {
    const { app } = await setup({}, [
      {
        method: "GET",
        path: /^\/intents\/broken-json$/,
        respond: { status: 200, body: undefined, rawBody: "{not-json" },
      },
    ]);

    const res = await app.request("/intents/broken-json");

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(
      "The upstream service returned an invalid response.",
    );
  });

  it("returns the same stable 502 when successful JSON misses the intent schema", async () => {
    const { app } = await setup({}, [
      {
        method: "GET",
        path: /^\/intents\/broken-schema$/,
        respond: { status: 200, body: { intent: { id: "only-an-id" } } },
      },
    ]);

    const res = await app.request("/intents/broken-schema");

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(
      "The upstream service returned an invalid response.",
    );
  });
});

describe("/api/* proxy routing", () => {
  it("with no grant cookie, hits the mock upstream only", async () => {
    const { app, mockUpstream, liveUpstream } = await setup();
    const res = await app.request("/api/intents/abc-1");
    expect(res.status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("with a valid, bound, unexhausted grant cookie, hits the live upstream only", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { cookieHeader } = await mintAndBindGrant(grantStore, now);

    const res = await app.request("/api/intents/abc-1", {
      headers: { cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
    expect(liveUpstream.requests).toHaveLength(1);
    expect(mockUpstream.requests).toHaveLength(0);
  });

  it("with a valid apo_grant cookie but NO matching apo_grant_session cookie, falls back to mock (bearer token alone is not enough)", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { token } = await mintAndBindGrant(grantStore, now);

    // Only the raw signed token — as if copied from a log, or set by hand
    // via `Cookie: apo_grant=<token>` without ever visiting the one-shot
    // GET /grant/:token activation link.
    const res = await app.request("/api/intents/abc-1", {
      headers: { cookie: `apo_grant=${token}` },
    });
    expect(res.status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("falls back to mock for an expired grant cookie", async () => {
    const { grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { cookieHeader } = await mintAndBindGrant(grantStore, now, {
      ttlSeconds: 1,
    });
    // Requests after this point use the fixed `now` from setup(), which is
    // in the PAST relative to a grant that already expired one second after
    // `now` — so build a second app instance with a later clock instead.
    const later = new Date(now.getTime() + 10_000);
    const app2 = createGatewayApp({
      grantStore,
      liveBudgetStore: new InMemoryLiveBudgetStore(),
      adminSecret: ADMIN_SECRET,
      grantSigningKey: GRANT_SIGNING_KEY,
      publicBaseUrl: PUBLIC_BASE_URL,
      agentOrchestratorUrl: mockUpstream.baseUrl,
      agentOrchestratorLiveUrl: liveUpstream.baseUrl,
      grantDefaultTtlSeconds: 86_400,
      grantDefaultMaxCalls: 20,
      liveCallsPerDay: 200,
      clock: () => later,
    });

    const res = await app2.request("/api/intents/abc-1", {
      headers: { cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
    expect(liveUpstream.requests).toHaveLength(0);
  });
});

describe("live-mode budget accounting", () => {
  it("rejects a declared body over 1 MiB before an upstream call or budget claim", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now);

    const res = await app.request("/api/intents", {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/json",
        "content-length": String(1_048_577),
      },
      body: JSON.stringify({ text: "small actual body" }),
    });

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("cancels an undeclared multi-chunk body over 1 MiB before an upstream call or budget claim", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now);
    let canceled = false;
    const request = chunkedPostRequest(
      "/api/intents",
      [
        new TextEncoder().encode("x".repeat(700_000)),
        new TextEncoder().encode("y".repeat(400_000)),
        new TextEncoder().encode("must-not-be-read"),
      ],
      {
        cookie: cookieHeader,
        "content-type": "application/json",
      },
      () => {
        canceled = true;
      },
    );

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    expect(canceled).toBe(true);
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("decrements only on POST /intents and POST /intents/:id/clarify — not approve/reject/GET", async () => {
    const { app, grantStore, now } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now, {
      maxCalls: 10,
    });
    const cookie = cookieHeader;

    await app.request("/api/intents/abc-1", { headers: { cookie } });
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);

    await app.request("/api/intents/abc-1/approve", {
      method: "POST",
      headers: { cookie },
    });
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);

    await app.request("/api/intents/abc-1/reject", {
      method: "POST",
      headers: { cookie },
    });
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);

    await app.request("/api/intents", { method: "POST", headers: { cookie } });
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(1);

    await app.request("/api/intents/abc-1/clarify", {
      method: "POST",
      headers: { cookie },
    });
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(2);
  });

  it("does not bypass the budget check via a same-origin //-shaped path (POST /api//<live authority>/intents)", async () => {
    const { app, grantStore, liveUpstream, now } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now, {
      maxCalls: 5,
    });
    const liveAuthority = new URL(liveUpstream.baseUrl).host;

    // `subPath` here is `//<liveAuthority>/intents` — a network-path
    // reference whose authority happens to ALREADY equal the live
    // upstream's own, so `resolveWithinOrigin`'s origin check alone would
    // let it through, and it resolves to the real `POST /intents` route.
    // Matching the budget check against `target.pathname` (not the raw,
    // `//`-shaped `subPath` string) is what closes this — see
    // `resolveWithinOrigin`'s own header for the full reasoning, including
    // why this input is ALSO rejected outright before reaching that far.
    const res = await app.request(`/api//${liveAuthority}/intents`, {
      method: "POST",
      headers: { cookie: cookieHeader },
    });

    const grantAfter = await grantStore.findByJti(jti);
    if (res.status === 200) {
      // If a future change ever lets this shape reach the upstream again,
      // the ONE thing that must never regress is silent, unbudgeted
      // execution — the budget must have been charged.
      expect(grantAfter?.usedCalls).toBe(1);
    } else {
      // As currently implemented, resolveWithinOrigin's up-front shape
      // rejection refuses the request outright — it never reaches the live
      // upstream at all, and the budget is correspondingly untouched.
      expect(liveUpstream.requests).toHaveLength(0);
      expect(grantAfter?.usedCalls).toBe(0);
    }
  });

  it("429s once exhausted, never silently falls back to mock", async () => {
    const { app, grantStore, mockUpstream, liveUpstream, now } = await setup();
    const { cookieHeader } = await mintAndBindGrant(grantStore, now, {
      maxCalls: 1,
    });
    const cookie = cookieHeader;

    const first = await app.request("/api/intents", {
      method: "POST",
      headers: { cookie },
    });
    expect(first.status).toBe(200);
    expect(liveUpstream.requests).toHaveLength(1);

    const second = await app.request("/api/intents", {
      method: "POST",
      headers: { cookie },
    });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("grant_exhausted");
    // The exhausted call must never have reached EITHER upstream.
    expect(liveUpstream.requests).toHaveLength(1);
    expect(mockUpstream.requests).toHaveLength(0);
  });

  it("429s once the global daily budget is exhausted, independent of the grant's own remaining calls", async () => {
    const { grantStore, mockUpstream, liveUpstream, now } = await setup();
    const liveBudgetStore = new InMemoryLiveBudgetStore();
    const app = createGatewayApp({
      grantStore,
      liveBudgetStore,
      adminSecret: ADMIN_SECRET,
      grantSigningKey: GRANT_SIGNING_KEY,
      publicBaseUrl: PUBLIC_BASE_URL,
      agentOrchestratorUrl: mockUpstream.baseUrl,
      agentOrchestratorLiveUrl: liveUpstream.baseUrl,
      grantDefaultTtlSeconds: 86_400,
      grantDefaultMaxCalls: 20,
      liveCallsPerDay: 1,
      clock: () => now,
    });
    const { cookieHeader } = await mintAndBindGrant(grantStore, now, {
      maxCalls: 10,
    });
    const cookie = cookieHeader;

    const first = await app.request("/api/intents", {
      method: "POST",
      headers: { cookie },
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/intents", {
      method: "POST",
      headers: { cookie },
    });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("daily_budget_exhausted");
  });
});

describe("proxy hygiene", () => {
  it("never forwards X-Admin-Secret or Cookie to the upstream", async () => {
    const { app, mockUpstream } = await setup();
    await app.request("/api/intents/abc-1", {
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
        cookie: "apo_grant=whatever; apo_customer_id=whatever",
      },
    });
    expect(mockUpstream.requests).toHaveLength(1);
    const forwarded = mockUpstream.requests[0]?.headers ?? {};
    expect(Object.keys(forwarded)).not.toContain("x-admin-secret");
    expect(Object.keys(forwarded)).not.toContain("cookie");
  });

  it("never forwards hop-by-hop headers (transfer-encoding, te, trailer, upgrade, keep-alive, proxy-authorization, proxy-connection) to the upstream", async () => {
    const { app, mockUpstream } = await setup();
    await app.request("/api/intents/abc-1", {
      headers: {
        "transfer-encoding": "chunked",
        te: "trailers",
        trailer: "X-Foo",
        upgrade: "websocket",
        "keep-alive": "timeout=5",
        "proxy-authorization": "Basic whatever",
        "proxy-connection": "keep-alive",
      },
    });
    expect(mockUpstream.requests).toHaveLength(1);
    const forwarded = Object.keys(mockUpstream.requests[0]?.headers ?? {});
    for (const header of [
      "transfer-encoding",
      "te",
      "trailer",
      "upgrade",
      "keep-alive",
      "proxy-authorization",
      "proxy-connection",
    ]) {
      expect(forwarded).not.toContain(header);
    }
  });

  it("always sets X-Customer-Id from the gateway's own session cookie, overriding any client-supplied value", async () => {
    const { app, mockUpstream } = await setup();
    const res = await app.request("/api/intents/abc-1", {
      headers: { "X-Customer-Id": "attacker-supplied-id" },
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("apo_customer_id=");
    const forwardedCustomerId =
      mockUpstream.requests[0]?.headers["x-customer-id"];
    expect(forwardedCustomerId).not.toBe("attacker-supplied-id");
  });

  it("does not proxy /internal/*", async () => {
    const { app, mockUpstream, liveUpstream } = await setup();
    const res = await app.request("/internal/live-grants-listing");
    expect(res.status).toBe(404);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("404s a protocol-relative path on /api/* instead of reaching an arbitrary origin (SSRF regression)", async () => {
    const { app, mockUpstream, liveUpstream } = await setup();
    const evilServer = await startFakeUpstream([
      {
        method: "GET",
        path: /.*/,
        respond: { status: 200, body: { secrets: "leaked" } },
        repeat: true,
      },
    ]);
    const evilHost = new URL(evilServer.baseUrl).host;

    // `new URL("//" + evilHost + "/x", upstream.base)` is a WHATWG
    // "network-path reference": it REPLACES the base's authority instead of
    // resolving against it, so a naive `new URL(subPath, base)` would
    // silently fetch `evilHost` instead of the intended upstream.
    const res = await app.request(`/api//${evilHost}/admin/secrets`);

    expect(res.status).toBe(404);
    expect(evilServer.requests).toHaveLength(0);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
    // The attacker-controlled response must never be reflected back,
    // including its Set-Cookie.
    expect(res.headers.get("set-cookie")).not.toContain("secrets");
  });

  it("404s a backslash-escaped path on /api/* the same way (WHATWG normalizes \\ to / for http(s) before the network-path check)", async () => {
    const { app, mockUpstream, liveUpstream } = await setup();
    const evilServer = await startFakeUpstream([
      {
        method: "GET",
        path: /.*/,
        respond: { status: 200, body: { secrets: "leaked" } },
        repeat: true,
      },
    ]);
    const evilHost = new URL(evilServer.baseUrl).host;

    const res = await app.request(`/api/\\${evilHost}/admin/secrets`);

    expect(res.status).toBe(404);
    expect(evilServer.requests).toHaveLength(0);
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
  });

  it("a same-origin absolute-looking id on GET /intents/:id never escapes the intended upstream origin", async () => {
    const { app, mockUpstream, liveUpstream } = await setup();
    const evilServer = await startFakeUpstream([
      {
        method: "GET",
        path: /.*/,
        respond: { status: 200, body: { secrets: "leaked" } },
        repeat: true,
      },
    ]);
    const evilHost = new URL(evilServer.baseUrl).host;

    // A route param can never itself begin the resolved path with "//" (it
    // is always appended after the fixed "/intents/" prefix — see
    // `resolveWithinOrigin`'s call site in `GET /intents/:id`), but this
    // pins that invariant with a value that WOULD be dangerous if that
    // prefix were ever removed.
    await app.request(`/intents/${encodeURIComponent(`/${evilHost}/x`)}`);

    expect(evilServer.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
    // Reaches the mock upstream instead (which 404s the made-up id via the
    // scripted catch-all's 200, or whatever it's scripted to answer) — the
    // key assertion is WHICH origin was reached, not the exact status.
    expect(mockUpstream.requests.length).toBeGreaterThan(0);
  });
});

interface HungServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** A real TCP server that accepts every connection and never writes a response — the only reliable way to exercise a genuine `fetch` timeout (a connection-refused/DNS-failure error resolves near-instantly and would race the timeout instead of testing it). */
async function startHungServer(): Promise<HungServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {
      /* accept the connection, never respond */
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("startHungServer: failed to bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              res();
            });
          }),
      });
    });
  });
}

describe("upstream timeouts", () => {
  it.each(["", "?poll=1"])(
    "returns HTML 504 on GET /intents/:id when the upstream never responds%s",
    async (query) => {
      const hungServer = await startHungServer();
      const grantStore = new InMemoryGrantStore();
      // A short override so this test doesn't wait out the real 15s
      // production default — see GatewayAppDeps.defaultUpstreamTimeoutMs.
      const app = createGatewayApp({
        grantStore,
        liveBudgetStore: new InMemoryLiveBudgetStore(),
        adminSecret: ADMIN_SECRET,
        grantSigningKey: GRANT_SIGNING_KEY,
        publicBaseUrl: PUBLIC_BASE_URL,
        agentOrchestratorUrl: hungServer.baseUrl,
        agentOrchestratorLiveUrl: undefined,
        grantDefaultTtlSeconds: 86_400,
        grantDefaultMaxCalls: 20,
        liveCallsPerDay: 200,
        defaultUpstreamTimeoutMs: 100,
      });

      try {
        const res = await app.request(`/intents/abc-1${query}`);
        expect(res.status).toBe(504);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(await res.text()).toContain(
          "The upstream service took too long",
        );
      } finally {
        await hungServer.close();
      }
    },
  );

  it("returns 504 on the /api/* proxy when the upstream never responds", async () => {
    const hungServer = await startHungServer();
    const grantStore = new InMemoryGrantStore();
    const app = createGatewayApp({
      grantStore,
      liveBudgetStore: new InMemoryLiveBudgetStore(),
      adminSecret: ADMIN_SECRET,
      grantSigningKey: GRANT_SIGNING_KEY,
      publicBaseUrl: PUBLIC_BASE_URL,
      agentOrchestratorUrl: hungServer.baseUrl,
      agentOrchestratorLiveUrl: undefined,
      grantDefaultTtlSeconds: 86_400,
      grantDefaultMaxCalls: 20,
      liveCallsPerDay: 200,
      defaultUpstreamTimeoutMs: 100,
    });

    try {
      const res = await app.request("/api/intents/abc-1");
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("upstream_timeout");
    } finally {
      await hungServer.close();
    }
  });
});

describe("GET /healthz", () => {
  it("returns 200 ok, liveness-only", async () => {
    const { app } = await setup();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("guided scenario boundary", () => {
  it.each(["clarify-and-pay", "decline-payment", "block-wrong-amount"])(
    "starts %s in a fresh customer session through the existing proxy",
    async (id) => {
      const { BROWSER_SCENARIOS } = await import("./browser-scenarios.js");
      const { app, mockUpstream, liveUpstream } = await setup({}, [
        {
          method: "POST",
          path: /^\/intents$/,
          respond: { status: 201, body: { intent: { id: "created" } } },
        },
      ]);
      const response = await app.request(`/ui/scenarios/${id}`, {
        method: "POST",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/intents/created");
      expect(response.headers.get("set-cookie")).toContain("apo_customer_id=");
      expect(mockUpstream.requests[0]?.body).toEqual({
        text: BROWSER_SCENARIOS.find((s) => s.id === id)?.text,
      });
      expect(mockUpstream.requests[0]?.headers["x-customer-id"]).toBeTruthy();
      expect(liveUpstream.requests).toHaveLength(0);
    },
  );

  it("refuses arbitrary scenario ids and ignores visitor supplied fixture text", async () => {
    const { app, mockUpstream } = await setup();
    const response = await app.request("/ui/scenarios/arbitrary", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=evil",
    });
    expect(response.status).toBe(404);
    expect(mockUpstream.requests).toHaveLength(0);
  });

  it("does not dispatch prepared directives into live reasoning or spend a grant", async () => {
    const { app, grantStore, now, mockUpstream, liveUpstream } = await setup();
    const { jti, cookieHeader } = await mintAndBindGrant(grantStore, now);
    const response = await app.request("/ui/scenarios/clarify-and-pay", {
      method: "POST",
      headers: { cookie: cookieHeader },
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Switch back to mock");
    expect(mockUpstream.requests).toHaveLength(0);
    expect(liveUpstream.requests).toHaveLength(0);
    expect((await grantStore.findByJti(jti))?.usedCalls).toBe(0);
  });

  it("renders poll failures as a stopped HTML view with manual retry", async () => {
    const { app } = await setup({}, [
      {
        method: "GET",
        path: /^\/intents\/polling$/,
        respond: { status: 503, body: { error: "down" } },
      },
    ]);
    const res = await app.request("/intents/polling?poll=2");
    const out = await res.text();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(out).toContain("Retry loading this payment");
    expect(out).not.toContain('http-equiv="refresh"');
    expect(out).not.toContain("Payment completed");
  });

  it("carries actual policy and answer fields into detail and caps visitor poll values", async () => {
    const { app } = await setup({}, [
      {
        method: "GET",
        path: /^\/intents\/polling$/,
        respond: {
          status: 200,
          body: {
            intent: {
              id: "polling",
              text: "Pay vendor",
              status: "executing",
              proposal: null,
              durableLedgerEventId: "event",
              clarificationAnswer: "<script>bad</script>",
              policyVerdict: {
                decision: "needs_approval",
                reason: "above_auto_approve_threshold",
                detail: "Review required",
              },
            },
          },
        },
      },
    ]);
    const out = await (await app.request("/intents/polling?poll=9000")).text();
    expect(out).toContain("Review required");
    expect(out).toContain("&lt;script&gt;bad");
    expect(out).toContain("Automatic checks paused");
    expect(out).not.toContain('http-equiv="refresh"');
  });
});

describe("local browser customer continuity", () => {
  // Models the relevant Safari rule: do not store a Secure cookie received
  // over plain HTTP, including loopback. This is not a general cookie jar.
  function acceptedCustomerCookie(
    response: Response,
    requestUrl: string,
  ): string | undefined {
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("apo_customer_id="));
    if (
      cookie === undefined ||
      (new URL(requestUrl).protocol === "http:" &&
        /;\s*Secure(?:;|$)/i.test(cookie))
    )
      return undefined;
    return cookie.split(";", 1)[0];
  }

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "keeps a fresh %s HTTP scenario in the same strict-cookie browser session",
    async (host) => {
      const { BROWSER_SCENARIOS } = await import("./browser-scenarios.js");
      const { app, mockUpstream } = await setup({}, [
        {
          method: "POST",
          path: /^\/intents$/,
          respond: { status: 201, body: { intent: { id: "fresh-browser" } } },
        },
        {
          method: "GET",
          path: /^\/intents\/fresh-browser$/,
          respond: {
            status: 200,
            body: {
              intent: {
                id: "fresh-browser",
                status: "needs_clarification",
                text: BROWSER_SCENARIOS[0].text,
                proposal: { kind: "clarify", question: "Which amount?" },
                durableLedgerEventId: null,
              },
            },
          },
        },
      ]);
      const startUrl = `http://${host}/ui/scenarios/clarify-and-pay`;
      const start = await app.request(startUrl, { method: "POST" });
      expect(start.status).toBe(303);
      const cookie = acceptedCustomerCookie(start, startUrl);
      expect(cookie).toBeDefined();
      const previousBehavior = new Response(null, {
        headers: {
          "set-cookie": `${cookie ?? ""}; Secure; HttpOnly; SameSite=Lax; Path=/`,
        },
      });
      expect(
        acceptedCustomerCookie(previousBehavior, startUrl),
      ).toBeUndefined();
      const detail = await app.request(
        new URL(start.headers.get("location") ?? "", startUrl).href,
        { headers: { cookie: cookie ?? "" } },
      );
      expect(detail.status).toBe(200);
      expect(await detail.text()).toContain("Which amount?");
      expect(mockUpstream.requests[1]?.headers["x-customer-id"]).toBe(
        mockUpstream.requests[0]?.headers["x-customer-id"],
      );
      const stored =
        start.headers
          .getSetCookie()
          .find((value) => value.startsWith("apo_customer_id=")) ?? "";
      expect(stored).toContain("HttpOnly");
      expect(stored).toContain("SameSite=Lax");
      expect(stored).toContain("Path=/");
      expect(stored).toContain("Max-Age=2592000");
    },
  );

  it.each([
    "http://public.example",
    "http://localhost.evil",
    "http://foo.localhost",
    "http://127.0.0.2",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
  ])(
    "retains Secure on %s despite spoofed forwarding headers",
    async (origin) => {
      const { app } = await setup();
      const response = await app.request(`${origin}/`, {
        headers: {
          host: "localhost",
          "x-forwarded-host": "localhost",
          "x-forwarded-proto": "http",
          forwarded: "host=localhost;proto=http",
        },
      });
      const cookie =
        response.headers
          .getSetCookie()
          .find((value) => value.startsWith("apo_customer_id=")) ?? "";
      expect(cookie).toMatch(/;\s*Secure(?:;|$)/);
    },
  );
});

describe("browser detail error recovery", () => {
  it.each(["", "?poll=1"])(
    "renders missing and other-owner payment responses identically%s",
    async (query) => {
      const { app } = await setup({}, [
        {
          method: "GET",
          path: /^\/intents\//,
          respond: {
            status: 404,
            body: { error: { message: "Private owner information" } },
          },
          repeat: true,
        },
      ]);
      const missing = await app.request(`/intents/missing${query}`);
      const other = await app.request(`/intents/other-owner${query}`);
      expect(missing.status).toBe(404);
      expect(other.status).toBe(404);
      const out = await missing.text();
      expect(out).toContain(
        "This payment could not be found in this browser session.",
      );
      expect(await other.text()).toContain(
        "This payment could not be found in this browser session.",
      );
      expect(out).toContain("Retry loading this payment");
      expect(out).toContain("Back to scenarios");
      expect(out).not.toContain("Private owner information");
      expect(out).not.toContain("<form");
      expect(out).not.toContain('http-equiv="refresh"');
    },
  );

  it.each(["", "?poll=1"])(
    "renders malformed JSON, schema and upstream failures as HTML%s",
    async (query) => {
      const { app } = await setup({}, [
        {
          method: "GET",
          path: /^\/intents\/json$/,
          respond: { status: 200, body: undefined, rawBody: "bad-json" },
        },
        {
          method: "GET",
          path: /^\/intents\/schema$/,
          respond: { status: 200, body: { intent: { id: "schema" } } },
        },
        {
          method: "GET",
          path: /^\/intents\/upstream$/,
          respond: { status: 503, body: { error: "private detail" } },
        },
      ]);
      for (const id of ["json", "schema", "upstream"]) {
        const response = await app.request(`/intents/${id}${query}`);
        expect(response.status).toBe(502);
        expect(response.headers.get("content-type")).toContain("text/html");
        const out = await response.text();
        expect(out).toContain("Retry loading this payment");
        expect(out).not.toContain('http-equiv="refresh"');
        expect(out).not.toContain("private detail");
      }
    },
  );

  it.each(["", "?poll=1"])(
    "renders network failure with a safe retry URL%s",
    async (query) => {
      const { app } = await setup({
        agentOrchestratorUrl: "http://127.0.0.1:1",
      });
      const response = await app.request(
        `/intents/${encodeURIComponent('<img src=x onerror="bad">')}${query}`,
      );
      expect(response.status).toBe(502);
      const out = await response.text();
      expect(out).toContain("Retry loading this payment");
      expect(out).toContain("%3Cimg%20src%3Dx%20onerror%3D%22bad%22%3E");
      expect(out).not.toContain("<img");
      expect(out).not.toContain('http-equiv="refresh"');
    },
  );
});

describe("same-page action response negotiation", () => {
  it("returns a JSON intent reference without navigation for console actions", async () => {
    const { app } = await setup({}, [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: { status: 201, body: { intent: { id: "console-intent" } } },
      },
    ]);
    const response = await app.request("/ui/intents", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "text=Pay+vendor&submissionKey=" + SUBMISSION_KEY,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ intent: { id: "console-intent" } });
  });
  it("returns a recoverable JSON action error when requested by the console", async () => {
    const { app } = await setup();
    const response = await app.request("/ui/intents", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "text=",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "Intent text is required." },
    });
  });
});

describe("failure challenge UI boundary", () => {
  it("dispatches only the fixed scenario through the proxy with a fresh customer", async () => {
    const { app, mockUpstream } = await setup({}, [
      {
        method: "POST",
        path: /^\/demo\/challenges$/,
        respond: { status: 201, body: { intent: { id: "challenge-owned" } } },
      },
    ]);
    const response = await app.request("/ui/challenges", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "scenario=duplicates&paymentMethodToken=unsafe&amount=1",
    });
    expect(response.status).toBe(200);
    expect(mockUpstream.requests[0]?.body).toEqual({ scenario: "duplicates" });
    expect(mockUpstream.requests[0]?.headers["x-customer-id"]).toBeTruthy();
  });
  it("rejects unknown challenge ids before upstream IO", async () => {
    const { app, mockUpstream } = await setup();
    expect(
      (
        await app.request("/ui/challenges", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "scenario=custom",
        })
      ).status,
    ).toBe(400);
    expect(mockUpstream.requests).toHaveLength(0);
  });
});

describe("mock manual submission identity", () => {
  it("renders a nonsecret key and forwards a text-bound stable key only in mock mode", async () => {
    const { app, mockUpstream } = await setup({}, [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: { status: 201, body: { intent: { id: "keyed" } } },
        repeat: true,
      },
    ]);
    const page = await app.request("/");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).not.toContain('id="submission-key"');
    const key = SUBMISSION_KEY;
    const post = (text: string) =>
      app.request("/ui/intents", {
        method: "POST",
        headers: {
          cookie: "apo_customer_id=customer-key",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ text, submissionKey: key }).toString(),
      });
    expect((await post("Pay vendor $73.45")).status).toBe(303);
    expect((await post("Pay vendor $73.45")).status).toBe(303);
    expect((await post("Pay vendor $74.45")).status).toBe(303);
    const keys = mockUpstream.requests.map(
      (request) => request.headers["idempotency-key"],
    );
    expect(keys[0]).toMatch(/^ui-[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(mockUpstream.requests[0]?.body).toEqual({
      text: "Pay vendor $73.45",
    });
  });
  it.each([
    "",
    "&submissionKey=not-a-uuid",
    `&submissionKey=${SUBMISSION_KEY}&submissionKey=${SUBMISSION_KEY}`,
  ])(
    "rejects missing or ambiguous mock form identities before dispatch: %s",
    async (suffix) => {
      const { app, mockUpstream } = await setup();
      const response = await app.request("/ui/intents", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "text=Pay+vendor+73.45" + suffix,
      });
      expect(response.status).toBe(400);
      expect(mockUpstream.requests).toHaveLength(0);
    },
  );
  it("leaves live manual submissions unkeyed even with a forged mock mode and malformed form key", async () => {
    const { app, grantStore, liveUpstream, now } = await setup(
      {},
      [],
      [
        {
          method: "POST",
          path: /^\/intents$/,
          respond: { status: 201, body: { intent: { id: "live" } } },
        },
      ],
    );
    const { cookieHeader } = await mintAndBindGrant(grantStore, now);
    const response = await app.request("/ui/intents", {
      method: "POST",
      headers: {
        cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
        "x-llm-mode": "mock",
      },
      body: "text=Pay+vendor+73.45&submissionKey=bad&mode=mock",
    });
    expect(response.status).toBe(303);
    expect(
      liveUpstream.requests[0]?.headers["idempotency-key"],
    ).toBeUndefined();
    expect(liveUpstream.requests[0]?.body).toEqual({
      text: "Pay vendor 73.45",
    });
  });
  it("executes permitted low values through the real existing keyed boundary, retaining approval and policy stops", async () => {
    const factory = (await import(
      new URL(
        "../../../../agent-orchestrator/src/composition-root.ts",
        import.meta.url,
      ).href
    )) as {
      createInMemoryAgentOrchestrator(options: {
        agentCore: unknown;
        paymentMethodToken: string;
      }): { app: Hono };
    };
    const memory = (await import(
      new URL(
        "../../../../agent-orchestrator/src/adapters/memory/fake-agent-core-client.ts",
        import.meta.url,
      ).href
    )) as { FakeAgentCoreClient: new () => { calls: unknown[] } };
    const core = new memory.FakeAgentCoreClient();
    const agent = factory.createInMemoryAgentOrchestrator({
      agentCore: core,
      paymentMethodToken: "sim.ok",
    });
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const server = serve(
      { fetch: agent.app.fetch, port: 0, hostname: "127.0.0.1" },
      () => ready(),
    );
    await listening;
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected local TCP address");
      const { app } = await setup({
        agentOrchestratorUrl: `http://127.0.0.1:${address.port}`,
      });
      const submit = async (text: string, key = SUBMISSION_KEY) => {
        const response = await app.request("/ui/intents", {
          method: "POST",
          headers: {
            accept: "application/json",
            cookie: "apo_customer_id=real-key-customer",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ text, submissionKey: key }).toString(),
        });
        expect(response.status).toBe(200);
        const ack = (await response.json()) as { intent: { id: string } };
        const current = await app.request(`/api/intents/${ack.intent.id}`, {
          headers: { cookie: "apo_customer_id=real-key-customer" },
        });
        expect(current.status).toBe(200);
        return (await current.json()) as {
          intent: { id: string; status: string };
        };
      };
      const low = await submit("Pay the vendor $73.45 for supplies.");
      expect(low.intent.status).toBe("executing");
      expect(core.calls).toHaveLength(1);
      expect(
        (await submit("Pay the vendor $73.45 for supplies.")).intent.id,
      ).toBe(low.intent.id);
      expect(core.calls).toHaveLength(1);
      expect(
        (await submit("Pay the vendor $1,200.00 for supplies.")).intent.status,
      ).toBe("needs_approval");
      expect(
        (
          await submit(
            "Pay the vendor $73.45 for supplies. sim.amount.ungrounded",
          )
        ).intent.status,
      ).toBe("rejected");
      expect(core.calls).toHaveLength(1);
      const source = "Pay the vendor $73.45 for supplies. sim.clarify";
      const clarified = await submit(source);
      expect(clarified.intent.status).toBe("needs_clarification");
      const answer = await app.request(
        `/ui/intents/${clarified.intent.id}/clarify`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            cookie: "apo_customer_id=real-key-customer",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ answer: "Use $73.45" }).toString(),
        },
      );
      expect(answer.status).toBe(200);
      const continued = await submit(source);
      expect(continued.intent.id).toBe(clarified.intent.id);
      expect(continued.intent.status).toBe("executing");
      expect(core.calls).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("private experiment response caching", () => {
  it("overrides cacheable upstream intent and evidence GETs", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected local TCP address");
      const { app } = await setup({
        agentOrchestratorUrl: `http://127.0.0.1:${address.port}`,
      });
      for (const path of ["/api/intents/cache", "/api/intents/cache/evidence"])
        expect((await app.request(path)).headers.get("cache-control")).toBe(
          "no-store",
        );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
