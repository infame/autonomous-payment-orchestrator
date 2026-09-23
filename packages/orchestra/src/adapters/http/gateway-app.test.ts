import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
      body: new URLSearchParams({ text: "Pay the vendor." }).toString(),
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
      body: new URLSearchParams({ text: "Pay the vendor." }).toString(),
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
      body: new URLSearchParams({ text: "bad intent" }).toString(),
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
    expect(await res.json()).toEqual({
      error: {
        code: "upstream_response_invalid",
        message: "The upstream service returned an invalid response.",
      },
    });
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
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "upstream_response_invalid",
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
  it("returns 504 on GET /intents/:id when the upstream never responds", async () => {
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
      const res = await app.request("/intents/abc-1");
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("upstream_timeout");
    } finally {
      await hungServer.close();
    }
  });

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
