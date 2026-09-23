import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z, ZodError } from "zod";
import { Grant } from "../../domain/grant.js";
import type { GrantStore, LiveBudgetStore } from "../../ports/grant-store.js";
import { signGrant, verifyGrant } from "../../grant/token.js";
import { renderErrorPage, renderHome, renderIntentDetail } from "./ui.js";

const GRANT_COOKIE = "apo_grant";
/**
 * Set ALONGSIDE `apo_grant` when `GET /grant/:token` successfully binds a
 * grant to its first opener, carrying the SAME opaque marker just written
 * to `orchestra.live_grants.bound_session_id`. `resolveUpstream` requires
 * this cookie to match the grant row's `boundSessionId` before ever
 * routing to the live upstream — without this second cookie, `apo_grant`
 * alone is a bare bearer token: anyone holding the raw signed value (e.g.
 * copied from a proxy access log, or set by hand via
 * `Cookie: apo_grant=<token>`, no need to ever visit the activation link)
 * would get live access despite never having "opened" the grant. This is
 * what makes the one-shot bind an actual SESSION binding rather than only
 * an activation-link latch.
 */
const GRANT_SESSION_COOKIE = "apo_grant_session";
/** Per-browser identity forwarded upstream as `X-Customer-Id` (ADR-0014's bare, unsigned channel — this cookie is not a stronger identity claim than that header already was). */
const CUSTOMER_COOKIE = "apo_customer_id";
const CUSTOMER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const GRANT_TTL_SECONDS_MAX = 30 * 24 * 60 * 60;
const GRANT_MAX_CALLS_MAX = 1000;

/** Default timeout for a proxied upstream request. Long enough for a mock-mode call (deterministic, in-process) and for approve/reject/GET against either instance; NOT long enough for a real Anthropic call, which is why the two LLM-calling routes get `LLM_UPSTREAM_TIMEOUT_MS` instead — see `app.all("/api/*")`. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
/** Timeout for the two routes that reach a real model in live mode (`POST /intents`, `POST /intents/:id/clarify`) — generous enough for a slow Anthropic response without pinning a gateway socket forever on a hung upstream. */
const LLM_UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * The ONLY two routes that ever cause an `LlmClient.reason()` call in
 * `@apo/agent-orchestrator` (`server-schemas.ts`/`app.ts` there:
 * `SubmitIntent`/`AnswerClarification` are the sole two use-cases that call
 * the LLM port; `approve`/`reject`/`GET` never do). Budget is counted ONLY
 * against these two, matched against the path with the `/api` prefix
 * already stripped. RE-CHECK THIS CONSTANT if `agent-orchestrator` ever
 * adds a third LLM-calling route — silently undercounting live-LLM spend
 * defeats the whole point of the budget backstop.
 */
const LLM_CALLING_ROUTES: ReadonlyArray<{
  readonly method: string;
  readonly pattern: RegExp;
}> = [
  { method: "POST", pattern: /^\/intents$/ },
  { method: "POST", pattern: /^\/intents\/[^/]+\/clarify$/ },
];

function isLlmCallingRoute(method: string, path: string): boolean {
  return LLM_CALLING_ROUTES.some(
    (route) => route.method === method && route.pattern.test(path),
  );
}

const GrantRequestBody = z.object({
  ttlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .max(GRANT_TTL_SECONDS_MAX)
    .optional(),
  maxCalls: z.coerce
    .number()
    .int()
    .positive()
    .max(GRANT_MAX_CALLS_MAX)
    .optional(),
});

const UpstreamProposal = z
  .object({
    kind: z.enum(["propose_payment", "clarify", "decline"]),
    amount: z.number().optional(),
    currency: z.string().optional(),
    merchantId: z.string().optional(),
    reasoning: z.string().optional(),
    question: z.string().optional(),
    reason: z.string().optional(),
  })
  .nullable();

const UpstreamIntentResponse = z.object({
  intent: z.object({
    id: z.string(),
    status: z.string(),
    text: z.string(),
    proposal: UpstreamProposal,
    durableLedgerEventId: z.string().nullable(),
  }),
});

const UiActionSuccessResponse = z.object({
  intent: z.object({ id: z.string().min(1) }),
});

const UiActionErrorResponse = z.object({
  error: z.object({ message: z.string().min(1) }),
});

const UiSubmitForm = z.object({ text: z.string().min(1) });
const UiClarifyForm = z.object({ answer: z.string().min(1) });

export interface GatewayAppDeps {
  readonly grantStore: GrantStore;
  readonly liveBudgetStore: LiveBudgetStore;
  /** `undefined` disables `POST /internal/grant` entirely — it 404s, matching ADR-0014's existence-oracle reasoning for every other "you're not allowed here" case in this monorepo. */
  readonly adminSecret: string | undefined;
  /** `undefined` disables grants entirely — `GET /grant/:token` 404s and `/api/*` never resolves to the live upstream. */
  readonly grantSigningKey: string | undefined;
  readonly publicBaseUrl: string | undefined;
  readonly agentOrchestratorUrl: string;
  readonly agentOrchestratorLiveUrl: string | undefined;
  readonly grantDefaultTtlSeconds: number;
  readonly grantDefaultMaxCalls: number;
  readonly liveCallsPerDay: number;
  readonly clock?: () => Date;
  /** Overrides `DEFAULT_UPSTREAM_TIMEOUT_MS` — test-only knob so a timeout regression test doesn't have to wait out the real 15s production default. */
  readonly defaultUpstreamTimeoutMs?: number;
  /** Overrides `LLM_UPSTREAM_TIMEOUT_MS` — same reasoning as `defaultUpstreamTimeoutMs`. */
  readonly llmUpstreamTimeoutMs?: number;
}

/** A transport-level failure raised directly by this HTTP adapter (bad JSON, an oversized body, an upstream timeout) — mapped to its own status by `app.onError` below. Mirrors the sibling packages' own `HttpError` shape. */
class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bounds `POST /internal/grant`'s request body — its whole legal shape is two small optional numbers, so anything past a few hundred bytes is already malformed. Checked against `Content-Length` when the caller sends one (rejects before ever reading the body), and again against the actually-read text (a missing or dishonest `Content-Length` must not bypass the cap). */
const MAX_GRANT_REQUEST_BODY_BYTES = 4_096;

/** Bounds the `/api/*` proxy's own request body — 1 MiB is generous for a `SubmitIntent`/`AnswerClarification` payload (`intentText`/`answer` are capped at a few thousand characters upstream) while still being a hard boundary against an unbounded buffer read, checked against declared `Content-Length` up front and actual bytes as the stream is read. */
const MAX_PROXY_REQUEST_BODY_BYTES = 1_048_576;

/** Browser forms carry one short text field. Keep their adapter boundary much tighter than the generic JSON proxy while still leaving ample room for encoded UTF-8 text. */
const MAX_UI_FORM_BODY_BYTES = 64 * 1_024;

/**
 * Reads at most `maxBytes` from the request stream. Unlike `arrayBuffer()` /
 * `text()` this stops pulling as soon as the boundary is crossed and cancels
 * the reader, so an unbounded chunked upload is never fully materialized.
 */
async function readBoundedBody(
  c: Context,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declaredLength = c.req.header("content-length");
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large");
  }

  const stream = c.req.raw.body;
  if (stream === null) {
    return new ArrayBuffer(0);
  }
  interface RequestBodyReader {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  }
  const reader = stream.getReader() as unknown as RequestBodyReader;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const value = result.value;
      if (value === undefined) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("request body exceeded configured limit");
        } catch {
          // The 413 is authoritative even if the transport is already closed.
        }
        throw new HttpError(
          413,
          "payload_too_large",
          "Request body is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function readJsonBodyOrEmpty(c: Context): Promise<unknown> {
  const body = await readBoundedBody(c, MAX_GRANT_REQUEST_BODY_BYTES);
  const text = new TextDecoder().decode(body);
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

async function readUiForm(c: Context): Promise<URLSearchParams> {
  const body = await readBoundedBody(c, MAX_UI_FORM_BODY_BYTES);
  if (body.byteLength === 0) {
    return new URLSearchParams();
  }
  const mediaType = c.req.header("content-type")?.split(";", 1)[0]?.trim();
  if (mediaType !== "application/x-www-form-urlencoded") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "UI forms must use application/x-www-form-urlencoded",
    );
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

function singleFormField(
  form: URLSearchParams,
  name: string,
): string | undefined {
  const values = form.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

/** `timingSafeEqual` requires equal-length buffers; a length mismatch is itself timed against a same-length dummy first so the length check isn't the one branch left un-hardened. Not a hard guarantee against every timing side channel — matches this repo's existing posture (ADR-0014 accepts a plain non-constant-time compare elsewhere; this one is at least constant-time on the equal-length path). */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolves `pathOrUrl` against `base` and asserts the result is a genuine,
 * plain path on `base`'s own origin — the ONLY thing standing between this
 * gateway and an SSRF via `new URL(input, base)`'s own well-known
 * WHATWG-spec footgun: when `input` begins with `//` (a "network-path
 * reference" — e.g. `//evil.example.com/x`) or, for an `http(s)` base, with
 * a backslash (normalized to `/` by the URL parser before that same check,
 * so `/\evil.example.com/x` triggers it too), the parser REPLACES `base`'s
 * entire authority instead of resolving against it — `new URL("//evil.com/x",
 * "http://good.com")` silently returns `http://evil.com/x`, not an error.
 * `pathOrUrl` here is derived from `c.req.path`/a route param, i.e.
 * attacker-controlled, so every callsite that builds a proxy target MUST
 * go through this function and reject on a `null`, never call
 * `new URL(subPath, base)` directly and fetch the result.
 *
 * `pathOrUrl` is rejected UP FRONT, before ever reaching `new URL()`,
 * unless it is a plain path starting with EXACTLY ONE `/` (not `//`, not
 * `/\`). This is not redundant with the origin check below: a SAME-origin
 * network-path reference (e.g. `//<the-real-live-authority>/intents`, where
 * the authority happens to already equal `base`'s own) would otherwise
 * SURVIVE the origin check — it genuinely resolves to the right origin —
 * while still being a `//`-shaped reference that any caller matching on the
 * raw `pathOrUrl` string (rather than the returned URL's own `.pathname`)
 * could misclassify. Rejecting the shape outright makes every downstream
 * consumer of this function's return value safe by construction, rather
 * than relying on each one to remember "always read `.pathname` off the
 * RETURNED `URL`, never the raw input string" — see the `isLlmCallingRoute`
 * call site in `app.all("/api/*")`'s own history for exactly the class of
 * bug this guards against: an earlier version matched the LLM-budget check
 * against the raw, pre-resolution string.
 *
 * Also rejects a target carrying non-empty `username`/`password` (a
 * `http://user:pass@host/...`-shaped `pathOrUrl`, which `new URL` accepts
 * without complaint and which has no legitimate use here), and never lets
 * `new URL()` itself throw past this function — some malformed inputs
 * (stray `%`, an invalid IPv6-literal-shaped authority segment, …) throw
 * rather than fail gracefully; every such case is treated as a rejection
 * (`null`), never an uncaught exception reaching the generic 500.
 */
function resolveWithinOrigin(pathOrUrl: string, base: string): URL | null {
  if (
    !pathOrUrl.startsWith("/") ||
    pathOrUrl.startsWith("//") ||
    pathOrUrl.startsWith("/\\")
  ) {
    return null;
  }
  let target: URL;
  let baseUrl: URL;
  try {
    target = new URL(pathOrUrl, base);
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  if (target.origin !== baseUrl.origin) {
    return null;
  }
  if (target.username !== "" || target.password !== "") {
    return null;
  }
  return target;
}

/** Raised when a proxied upstream fetch is aborted by its own timeout (`DEFAULT_UPSTREAM_TIMEOUT_MS`/`LLM_UPSTREAM_TIMEOUT_MS`) — mapped to 504 by `app.onError`, distinct from every other `fetch` failure (network error, DNS failure, …), which still falls through to the generic 500: a hung upstream is a "come back later" signal, an unreachable one is closer to a real server fault here (this gateway's own misconfiguration or the upstream being down), and collapsing both into the same status would blur that distinction for an operator reading logs. */
class UpstreamTimeoutError extends Error {}

/**
 * `fetch` wrapped with a hard timeout — every outbound call this gateway
 * makes to either `agent-orchestrator` instance goes through this, never a
 * bare `fetch`, so a hung upstream (most plausibly a slow/unresponsive real
 * Anthropic call in live mode) can never pin a gateway socket open
 * indefinitely.
 *
 * Deliberately builds the deadline with a plain `AbortController` +
 * `setTimeout`, and identifies a timeout with a local `timedOut` flag set
 * by that same timer — NOT with `AbortSignal.timeout(ms)`, and NOT by
 * inspecting the rejected error's `.name` or passing (and later comparing)
 * a custom `abort(reason)` value. Both alternatives were tried and
 * rejected: this repo's root `tsconfig.base.json` has no `dom` lib, and
 * `@types/node`'s own typings for `AbortSignal.timeout` AND for
 * `AbortController.prototype.abort`'s `reason` parameter both sit behind a
 * `globalThis extends { onmessage: any }` conditional that does not
 * reliably resolve the way `@types/node`'s own doc comment intends in this
 * project's actual compilation — confirmed by hitting a real `tsc` error on
 * each attempt, not by reading the .d.ts alone. Empirically verified
 * separately (real Node, a TCP server that accepts and never responds)
 * that `fetch()` rejects with a plain `TypeError`/network-style error on
 * abort here, whose `.name` is NOT reliably `"AbortError"`/`"TimeoutError"`
 * either — so the flag is the only mechanism this function trusts.
 */
async function fetchUpstream(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new UpstreamTimeoutError(
        `upstream request to ${url.origin} timed out after ${String(timeoutMs)}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type UpstreamResolution =
  | { readonly isLive: false; readonly base: string; readonly grant: null }
  | { readonly isLive: true; readonly base: string; readonly grant: Grant };

/**
 * Resolves which `agent-orchestrator` instance a request should reach: the
 * live instance whenever the `apo_grant` cookie carries a token that
 * verifies (signature + exp) AND the corresponding Postgres row still
 * EXISTS and is UNEXPIRED AND the `apo_grant_session` cookie matches that
 * row's `boundSessionId` — read via `findByJti`, a read-only lookup used
 * here ONLY to pick a route, never to decide whether a budget claim
 * succeeds (that's `claimLiveBudget`'s atomic job, called separately for
 * the two LLM-calling routes). Falls back to mock for every other case:
 * missing/invalid/expired grant, a session-cookie mismatch (see
 * `GRANT_SESSION_COOKIE`'s own header — this is what stops a bare `apo_grant`
 * bearer token, copied out of a log or set by hand, from getting live
 * access without ever completing the one-shot activation flow), no cookie
 * at all, or a misconfigured gateway (no `GRANT_SIGNING_KEY` or no
 * `AGENT_ORCHESTRATOR_LIVE_URL`).
 *
 * Deliberately does NOT check `grant.isExhausted()` here — an exhausted but
 * unexpired grant still routes to the LIVE upstream. If this checked
 * exhaustion too, an exhausted grant hitting a budgeted route would silently
 * fall back to mock instead of the required 429 (`docs/todo/05-orchestra.md
 * §4`: "never a silent downgrade to mock" — scoped to EXHAUSTION; an
 * EXPIRED grant, by contrast, IS intended to fall back to mock silently,
 * including on a budgeted route — its grant relationship is simply over),
 * because `isLlmCallingRoute`'s 429 branch only runs when `upstream.isLive`
 * is already true. Routing an exhausted grant's non-budgeted calls
 * (`approve`/`reject`/`GET`) to the live instance anyway is harmless: both
 * agent-orchestrator instances share the same Postgres `agent` schema
 * (ADR-0020), so which one serves a non-LLM-calling read/write is
 * immaterial.
 */
async function resolveUpstream(
  c: Context,
  deps: GatewayAppDeps,
  now: Date,
): Promise<UpstreamResolution> {
  const mockResolution: UpstreamResolution = {
    isLive: false,
    base: deps.agentOrchestratorUrl,
    grant: null,
  };
  const token = getCookie(c, GRANT_COOKIE);
  if (
    token === undefined ||
    deps.grantSigningKey === undefined ||
    deps.agentOrchestratorLiveUrl === undefined
  ) {
    return mockResolution;
  }
  let claims;
  try {
    claims = verifyGrant(token, deps.grantSigningKey, now);
  } catch {
    return mockResolution;
  }
  const grant = await deps.grantStore.findByJti(claims.jti);
  if (grant === null || grant.isExpired(now)) {
    return mockResolution;
  }
  const sessionCookie = getCookie(c, GRANT_SESSION_COOKIE);
  if (
    sessionCookie === undefined ||
    grant.boundSessionId === null ||
    sessionCookie !== grant.boundSessionId
  ) {
    return mockResolution;
  }
  return { isLive: true, base: deps.agentOrchestratorLiveUrl, grant };
}

type LiveBudgetClaimResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "grant_exhausted" | "daily_budget_exhausted";
    };

/**
 * Atomically claims one call against BOTH the per-grant budget and the
 * global daily backstop, in that order. Accepted imprecision, mirroring
 * this repo's documented-risk posture (ADR-0019): if the per-grant claim
 * succeeds but the global claim then fails, the grant's own counter has
 * already been incremented for a call that never actually reaches the live
 * LLM. This is a small, one-call overcount against the CALLER's own budget
 * — never an undercount against the global backstop, and never a case where
 * a call proceeds without both claims having succeeded. Given this
 * gateway's default budgets (a grant's `maxCalls` far smaller than
 * `LIVE_CALLS_PER_DAY`), the global cap is expected to bind rarely, if
 * ever, making this an acceptable, documented trade rather than added
 * claim/release complexity.
 */
async function claimLiveBudget(
  deps: GatewayAppDeps,
  jti: string,
  now: Date,
): Promise<LiveBudgetClaimResult> {
  const grantClaim = await deps.grantStore.claimCall(jti, now);
  if (grantClaim === null) {
    return { ok: false, reason: "grant_exhausted" };
  }
  const day = now.toISOString().slice(0, 10);
  const budgetClaim = await deps.liveBudgetStore.claimCall(
    day,
    deps.liveCallsPerDay,
  );
  if (budgetClaim === null) {
    return { ok: false, reason: "daily_budget_exhausted" };
  }
  return { ok: true };
}

/** Reads (or mints and schedules-to-set) the per-browser customer id cookie. Never `HttpOnly: false` — this cookie is never read by client-side script, only forwarded by this server as `X-Customer-Id`. */
function ensureCustomerId(c: Context): string {
  const existing = getCookie(c, CUSTOMER_COOKIE);
  if (existing !== undefined) {
    return existing;
  }
  const fresh = randomUUID();
  setCookie(c, CUSTOMER_COOKIE, fresh, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: CUSTOMER_COOKIE_MAX_AGE_SECONDS,
  });
  return fresh;
}

/**
 * Never forwarded upstream. Two categories:
 *  - Sensitive/identity: `x-admin-secret`, `cookie`, `x-customer-id` (proxy
 *    hygiene — see `buildUpstreamHeaders`'s own header).
 *  - Hop-by-hop (RFC 9110 §7.6.1 plus the historical `Proxy-*` pair): these
 *    describe THIS connection (gateway↔caller), never the next one
 *    (gateway↔upstream), and `fetchUpstream` builds its own request from
 *    scratch — forwarding a caller's `Transfer-Encoding`/`Content-Length`
 *    alongside a body this handler has ALREADY buffered in full
 *    (`c.req.arrayBuffer()`) is actively wrong, not just redundant: undici
 *    throws when both are set inconsistently, turning an ordinary chunked
 *    request into an unauthenticated 500 instead of a clean proxy.
 */
const HOP_BY_HOP_OR_SENSITIVE_HEADERS = new Set([
  "x-admin-secret",
  "cookie",
  "host",
  "x-customer-id",
  "content-length",
  "connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
]);

/**
 * Builds the headers sent to whichever `agent-orchestrator` instance
 * `resolveUpstream` picked. `X-Admin-Secret` and `Cookie` are NEVER
 * forwarded — this is the whole point of this function existing rather than
 * forwarding `c.req.raw.headers` verbatim (proxy hygiene, security-reviewed:
 * `docs/todo/05-orchestra.md §4`). `X-Customer-Id` is always OVERWRITTEN
 * with this gateway's own per-browser session cookie value, never trusted
 * from an incoming `X-Customer-Id` header a caller sent directly — a client
 * cannot address another visitor's intents merely by setting that header.
 * This is NOT a stronger identity guarantee than ADR-0014's own bare,
 * unsigned `X-Customer-Id` model: the `apo_customer_id` COOKIE itself is
 * still an ordinary, unsigned, client-held value — a caller can still
 * present an arbitrary `X-Customer-Id`-equivalent identity by simply
 * setting that cookie instead of the header, exactly as ADR-0014 already
 * accepts for `agent-orchestrator` itself. All this function narrows is the
 * CHANNEL (cookie, not a directly-settable request header) and stops one
 * request from silently overriding another's already-established identity
 * mid-session by header alone.
 */
function buildUpstreamHeaders(c: Context, customerId: string): Headers {
  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers) {
    if (!HOP_BY_HOP_OR_SENSITIVE_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  headers.set("X-Customer-Id", customerId);
  return headers;
}

/**
 * Builds the `Cookie` header for an INTERNAL, in-process request a `/ui/*`
 * handler issues to this same app's own `/api/*` route (via `app.request()`
 * — see `createGatewayApp`'s own header on why `/ui/*` delegates rather
 * than re-implementing proxy/budget logic). Reconstructed explicitly from
 * the three cookies this gateway actually reads, rather than forwarding
 * `c.req.header("cookie")` verbatim, for one reason: `customerId` may have
 * just been FRESHLY MINTED by this same `/ui/*` handler's own
 * `ensureCustomerId(c)` call (queued via `setCookie`, not yet visible on
 * the INCOMING request's own Cookie header) — using the raw incoming
 * header here would make the internal `/api/*` call mint a SECOND,
 * different customer id than the one this handler's own response cookie
 * promises the browser, splitting one visitor across two identities.
 */
function buildInternalCookieHeader(c: Context, customerId: string): string {
  const parts = [`${CUSTOMER_COOKIE}=${customerId}`];
  const grantToken = getCookie(c, GRANT_COOKIE);
  if (grantToken !== undefined) {
    parts.push(`${GRANT_COOKIE}=${grantToken}`);
  }
  const sessionCookie = getCookie(c, GRANT_SESSION_COOKIE);
  if (sessionCookie !== undefined) {
    parts.push(`${GRANT_SESSION_COOKIE}=${sessionCookie}`);
  }
  return parts.join("; ");
}

/**
 * Builds the `orchestra` gateway Hono app — the only publicly-reachable
 * service in this system (ADR-0020). Routes: grant issuance (admin-gated),
 * grant activation (signature+exp gated), the mock-session escape hatch,
 * two server-rendered HTMX views, and the `/api/*` reverse proxy. Single
 * `onError`/`notFound`, matching every sibling package's HTTP adapter
 * convention.
 */
export function createGatewayApp(deps: GatewayAppDeps): Hono {
  const app = new Hono();
  const clock = deps.clock ?? (() => new Date());
  const defaultUpstreamTimeoutMs =
    deps.defaultUpstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const llmUpstreamTimeoutMs =
    deps.llmUpstreamTimeoutMs ?? LLM_UPSTREAM_TIMEOUT_MS;

  async function renderUiError(
    c: Context,
    message: string,
    status: ContentfulStatusCode,
  ): Promise<Response> {
    const upstream = await resolveUpstream(c, deps, clock());
    const remaining = upstream.isLive ? upstream.grant.remainingCalls : null;
    const rendered = await renderErrorPage(
      message,
      upstream.isLive ? "live" : "mock",
      remaining,
    );
    return c.html(rendered.toString(), status);
  }

  /**
   * Sends a browser form action back through this app's own `/api/*` route.
   * This keeps grant routing, budget claims, proxy timeouts, and header
   * filtering on one code path. The caller has already established the
   * browser's customer id; rebuilding the internal Cookie header is what
   * carries a newly minted id into this same request's nested API call.
   */
  async function dispatchUiAction(
    c: Context,
    apiPath: string,
    body?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const customerId = ensureCustomerId(c);
    const headers = new Headers({
      cookie: buildInternalCookieHeader(c, customerId),
    });
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const apiResponse = await app.request(`/api${apiPath}`, {
      method: "POST",
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    let envelope: unknown;
    try {
      envelope = await apiResponse.json();
    } catch {
      return renderUiError(
        c,
        "The upstream service returned an invalid response.",
        502,
      );
    }

    if (apiResponse.ok) {
      const parsed = UiActionSuccessResponse.safeParse(envelope);
      if (!parsed.success) {
        return renderUiError(
          c,
          "The upstream service returned an invalid response.",
          502,
        );
      }
      return c.redirect(
        `/intents/${encodeURIComponent(parsed.data.intent.id)}`,
        303,
      );
    }

    const parsedError = UiActionErrorResponse.safeParse(envelope);
    const message = parsedError.success
      ? parsedError.data.error.message
      : "The upstream service could not complete that action.";
    const status =
      apiResponse.status >= 400 && apiResponse.status <= 599
        ? (apiResponse.status as ContentfulStatusCode)
        : 502;
    return renderUiError(c, message, status);
  }

  // `public/htmx.min.js` is vendored into this repo, not CDN-loaded (OQ5,
  // `docs/todo/05-orchestra.md §5`) — the demo must not depend on an
  // external CDN staying up. `root: "./"` is relative to the process's cwd
  // (Node-server's `serveStatic` convention), which `Dockerfile` and
  // `pnpm start` both set to this package's own directory.
  app.use("/public/*", serveStatic({ root: "./" }));

  app.post("/internal/grant", async (c) => {
    const provided = c.req.header("X-Admin-Secret");
    if (
      deps.adminSecret === undefined ||
      provided === undefined ||
      !timingSafeStringEqual(provided, deps.adminSecret)
    ) {
      // 404, never 401/403 — ADR-0014's existence-oracle reasoning applies
      // here just as it does to a mismatched X-Customer-Id: a distinct
      // status for "wrong secret" vs "this route doesn't exist" would tell
      // an unauthenticated caller the endpoint is real and worth attacking.
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }
    if (deps.agentOrchestratorLiveUrl === undefined) {
      return c.json(
        {
          error: {
            code: "live_disabled",
            message: "Live mode is not configured on this deployment.",
          },
        },
        503,
      );
    }
    const body = GrantRequestBody.parse(await readJsonBodyOrEmpty(c));
    const now = clock();
    const ttlSeconds = body.ttlSeconds ?? deps.grantDefaultTtlSeconds;
    const maxCalls = body.maxCalls ?? deps.grantDefaultMaxCalls;
    const jti = randomUUID();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await deps.grantStore.create({ jti, expiresAt, maxCalls });

    // Both unreachable in practice: config.ts's superRefine requires
    // GRANT_SIGNING_KEY and PUBLIC_BASE_URL whenever ADMIN_SECRET is set,
    // and the ADMIN_SECRET check above already passed. Guarded explicitly
    // rather than asserted past the compiler with `!` — same discipline
    // agent-orchestrator's main.ts documents for its own analogous
    // ANTHROPIC_API_KEY re-check.
    if (deps.grantSigningKey === undefined) {
      throw new Error(
        "orchestra gateway: GRANT_SIGNING_KEY missing despite a valid ADMIN_SECRET — config.ts should make this unreachable",
      );
    }
    if (deps.publicBaseUrl === undefined) {
      throw new Error(
        "orchestra gateway: PUBLIC_BASE_URL missing despite a valid ADMIN_SECRET — config.ts should make this unreachable",
      );
    }
    const token = signGrant(
      { jti, exp: Math.floor(expiresAt.getTime() / 1000), maxCalls },
      deps.grantSigningKey,
    );
    return c.json({ url: `${deps.publicBaseUrl}/grant/${token}` }, 201);
  });

  app.get("/grant/:token", async (c) => {
    const token = c.req.param("token");
    if (deps.grantSigningKey === undefined) {
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }
    const now = clock();
    let claims;
    try {
      claims = verifyGrant(token, deps.grantSigningKey, now);
    } catch {
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }
    // A fresh, opaque marker — its only job is to make `bound_session_id`
    // non-null on first open, so a second opener of the same link (whose
    // `bindSession` call finds it already non-null) gets refused. See
    // `ports/grant-store.ts`'s `bindSession` header for why binding is
    // one-shot, not idempotent for re-opens.
    const sessionMarker = randomUUID();
    const bound = await deps.grantStore.bindSession(
      claims.jti,
      sessionMarker,
      now,
    );
    if (bound === null) {
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }
    const remainingSeconds = Math.max(
      1,
      claims.exp - Math.floor(now.getTime() / 1000),
    );
    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
      path: "/",
      maxAge: remainingSeconds,
    };
    setCookie(c, GRANT_COOKIE, token, cookieOptions);
    // Set ALONGSIDE apo_grant — see GRANT_SESSION_COOKIE's own header.
    // Without this second cookie, apo_grant alone is a bare bearer token
    // that anyone holding the raw signed value could replay for live
    // access without ever completing this activation flow.
    setCookie(c, GRANT_SESSION_COOKIE, sessionMarker, cookieOptions);
    return c.redirect("/", 302);
  });

  app.post("/session/mock", (c) => {
    deleteCookie(c, GRANT_COOKIE, { path: "/" });
    deleteCookie(c, GRANT_SESSION_COOKIE, { path: "/" });
    return c.redirect("/", 302);
  });

  app.get("/", async (c) => {
    ensureCustomerId(c);
    const upstream = await resolveUpstream(c, deps, clock());
    const remaining = upstream.isLive ? upstream.grant.remainingCalls : null;
    const rendered = await renderHome(
      upstream.isLive ? "live" : "mock",
      remaining,
    );
    return c.html(rendered.toString());
  });

  app.get("/intents/:id", async (c) => {
    const customerId = ensureCustomerId(c);
    const now = clock();
    const upstream = await resolveUpstream(c, deps, now);
    const id = c.req.param("id");
    // `id` is route-param-decoded, attacker-influenced text, and is only
    // ever safe from the `//host/...`-style SSRF `resolveWithinOrigin`
    // guards against here BY ACCIDENT of the fixed `/intents/` prefix
    // always occupying position 0 of the resolved string — asserted
    // explicitly anyway rather than relying on that accident staying true
    // across a future refactor.
    const target = resolveWithinOrigin(`/intents/${id}`, upstream.base);
    if (target === null) {
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }
    const upstreamRes = await fetchUpstream(
      target,
      { headers: { "X-Customer-Id": customerId } },
      defaultUpstreamTimeoutMs,
    );
    if (upstreamRes.status === 404) {
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }
    if (!upstreamRes.ok) {
      return c.json(
        {
          error: {
            code: "upstream_error",
            message: "Failed to load this intent.",
          },
        },
        502,
      );
    }
    let upstreamBody: unknown;
    try {
      upstreamBody = await upstreamRes.json();
    } catch {
      return c.json(
        {
          error: {
            code: "upstream_response_invalid",
            message: "The upstream service returned an invalid response.",
          },
        },
        502,
      );
    }
    const parsed = UpstreamIntentResponse.safeParse(upstreamBody);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "upstream_response_invalid",
            message: "The upstream service returned an invalid response.",
          },
        },
        502,
      );
    }
    const remaining = upstream.isLive ? upstream.grant.remainingCalls : null;
    const rendered = await renderIntentDetail(
      parsed.data.intent,
      upstream.isLive ? "live" : "mock",
      remaining,
    );
    return c.html(rendered.toString());
  });

  app.post("/ui/intents", async (c) => {
    const form = await readUiForm(c);
    const parsed = UiSubmitForm.safeParse({
      text: singleFormField(form, "text"),
    });
    if (!parsed.success) {
      return renderUiError(c, "Intent text is required.", 400);
    }
    return dispatchUiAction(c, "/intents", { text: parsed.data.text });
  });

  app.post("/ui/intents/:id/clarify", async (c) => {
    const form = await readUiForm(c);
    const parsed = UiClarifyForm.safeParse({
      answer: singleFormField(form, "answer"),
    });
    if (!parsed.success) {
      return renderUiError(c, "A clarification answer is required.", 400);
    }
    return dispatchUiAction(
      c,
      `/intents/${encodeURIComponent(c.req.param("id"))}/clarify`,
      { answer: parsed.data.answer },
    );
  });

  app.post("/ui/intents/:id/approve", async (c) => {
    await readUiForm(c);
    return dispatchUiAction(
      c,
      `/intents/${encodeURIComponent(c.req.param("id"))}/approve`,
    );
  });

  app.post("/ui/intents/:id/reject", async (c) => {
    await readUiForm(c);
    return dispatchUiAction(
      c,
      `/intents/${encodeURIComponent(c.req.param("id"))}/reject`,
    );
  });

  app.all("/api/*", async (c) => {
    const customerId = ensureCustomerId(c);
    const now = clock();
    const upstream = await resolveUpstream(c, deps, now);
    const subPath = c.req.path.slice("/api".length) || "/";

    const target = resolveWithinOrigin(subPath, upstream.base);
    if (target === null) {
      // A protocol-relative ("//evil.example.com/x") or backslash-escaped
      // ("/\evil.example.com/x") path made `new URL(subPath, base)` resolve
      // OUTSIDE the intended upstream's origin — see `resolveWithinOrigin`'s
      // own header. Reject BEFORE any budget claim or fetch, so a malformed
      // path can neither consume live-call budget nor reach an arbitrary
      // host.
      return c.json(
        { error: { code: "not_found", message: "Not found" } },
        404,
      );
    }

    // Matched against `target.pathname` (the WHATWG-canonicalized path),
    // NEVER the raw `subPath` string — see `resolveWithinOrigin`'s own
    // header for why a same-origin-but-oddly-shaped `subPath` (or any other
    // shape `new URL` normalizes away, e.g. a `..` segment) must never be
    // classified by matching the pre-resolution string.
    target.search = new URL(c.req.url).search;
    const headers = buildUpstreamHeaders(c, customerId);
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let body: ArrayBuffer | undefined;
    if (hasBody) {
      body = await readBoundedBody(c, MAX_PROXY_REQUEST_BODY_BYTES);
    }

    // Validate and buffer the complete body before claiming live budget.
    // A request rejected by this gateway must consume neither a per-grant
    // call nor the global daily allowance, and must never reach upstream.
    const isBudgeted =
      upstream.isLive && isLlmCallingRoute(c.req.method, target.pathname);
    if (isBudgeted) {
      const claim = await claimLiveBudget(deps, upstream.grant.jti, now);
      if (!claim.ok) {
        return c.json(
          {
            error: {
              code: claim.reason,
              message:
                "Live-mode call budget exhausted for this grant or for today.",
            },
          },
          429,
        );
      }
    }

    const upstreamRes = await fetchUpstream(
      target,
      {
        method: c.req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      },
      isBudgeted ? llmUpstreamTimeoutMs : defaultUpstreamTimeoutMs,
    );

    // Returning `upstreamRes` directly would DISCARD any `Set-Cookie` this
    // handler already queued on `c` via `ensureCustomerId` (Hono does not
    // retroactively merge `c.header()`/`setCookie(c, ...)` state into a
    // `Response` object returned verbatim from a handler) — so a freshly
    // minted `apo_customer_id` cookie would silently never reach the
    // browser on a visitor's very first proxied call. Build the real
    // response explicitly instead, copying the upstream's headers and then
    // appending whatever `Set-Cookie` entries `c`'s own response already
    // carries.
    const responseHeaders = new Headers(upstreamRes.headers);
    // Neither agent-orchestrator instance ever sets a cookie — both are
    // stateless JSON APIs with no session/cookie concept anywhere in their
    // HTTP adapters. Drop whatever `Set-Cookie` the upstream response
    // carries anyway, as defense in depth: this gateway alone owns
    // `apo_grant`/`apo_grant_session`/`apo_customer_id`, and a proxied
    // response — even a legitimate one, let alone one reached through some
    // future bug in `resolveWithinOrigin`'s own reasoning — must never be
    // able to set or clobber a cookie on this gateway's own origin.
    responseHeaders.delete("set-cookie");
    for (const setCookieValue of c.res.headers.getSetCookie()) {
      responseHeaders.append("set-cookie", setCookieValue);
    }
    const responseBody = await upstreamRes.arrayBuffer();
    return new Response(responseBody, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }, 200));

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: "Request validation failed",
          },
        },
        400,
      );
    }
    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        err.status,
      );
    }
    if (err instanceof UpstreamTimeoutError) {
      return c.json(
        {
          error: {
            code: "upstream_timeout",
            message: "The upstream service took too long to respond.",
          },
        },
        504,
      );
    }
    console.error("orchestra gateway: unhandled error", err);
    return c.json(
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
    );
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Not found" } }, 404),
  );

  return app;
}
