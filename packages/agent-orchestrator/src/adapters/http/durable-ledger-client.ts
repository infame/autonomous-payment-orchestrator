import { z } from "zod";
import type { ZodType } from "zod";
import type {
  AgentCoreClient,
  AgentCoreOperation,
  RequestOptions,
  StartPaymentWorkflowOptions,
  StartPaymentWorkflowRequest,
  StartPaymentWorkflowResult,
  WorkflowRunSnapshot,
} from "../../ports/agent-core-client.js";
import {
  AgentCoreBadRequestError,
  AgentCoreClientError,
  AgentCoreMalformedResponseError,
  AgentCoreNetworkError,
  AgentCoreRequestCanceledError,
  AgentCoreRunNotFoundError,
  AgentCoreTimeoutError,
  AgentCoreUnavailableError,
  AgentCoreUnexpectedResponseError,
} from "../../ports/agent-core-client.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * `AbortSignal.timeout`/`.any` are supported at runtime on Node 24 (this
 * package's minimum), but this monorepo's root `tsconfig.base.json`
 * (`lib: ["ES2023"]`, no `dom`) resolves `@types/node`'s ambient
 * `AbortSignal` static type without those two static methods. A narrow
 * local cast, used only at the two call sites below that need them —
 * transcribed from `packages/durable-ledger/src/adapters/http/pay-core-client.ts`.
 */
interface AbortSignalStatics {
  timeout(milliseconds: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
}
const AbortSignalStatics = AbortSignal as unknown as typeof AbortSignal &
  AbortSignalStatics;

export interface HttpDurableLedgerClientOptions {
  /** No default — every caller must say which durable-ledger instance to talk to. May include a path prefix (e.g. `http://localhost:3001/api`). */
  readonly baseUrl: string;
  /** Production callers set this shared secret; optional only for isolated adapter tests and embedded callers that deliberately run an unauthenticated test app. */
  readonly serviceSecret?: string;
  /** Falls back to `DEFAULT_REQUEST_TIMEOUT_MS` when unset; a per-call `RequestOptions.timeoutMs` overrides this. */
  readonly timeoutMs?: number;
}

const startPaymentWorkflowResponseSchema = z.object({
  eventId: z.string().min(1),
  statusUrl: z.string().min(1),
});

const workflowRunSnapshotSchema: ZodType<WorkflowRunSnapshot> = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  startedAt: z.string().min(1).nullable(),
  endedAt: z.string().min(1).nullable(),
  needsReview: z.boolean(),
  failureMessage: z.string().min(1).nullable(),
});

/**
 * Same contract as durable-ledger's IDEMPOTENCY_KEY_SHAPE
 * (src/adapters/inngest/inngest-workflow-runs.ts) and IdempotencyKeyHeader
 * (src/adapters/http/server-schemas.ts). Duplicated deliberately — validate
 * locally rather than trust a remote 400, same reasoning ADR-0013 gives for
 * durable-ledger's own adapter-level duplication.
 */
const IDEMPOTENCY_KEY_SHAPE = /^[\x21-\x7E]{1,200}$/;

interface RequestParams<T> {
  readonly operation: AgentCoreOperation;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: unknown;
  readonly schema: ZodType<T>;
  readonly timeoutMs: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly idempotencyKey: string | undefined;
}

/**
 * `fetch`-based `AgentCoreClient` implementation talking to `durable-ledger`
 * over HTTP (Node 24 built-in `fetch`, no new HTTP dependency). Both methods
 * funnel through one private `request<T>` helper that builds the URL/
 * headers/body, applies the timeout (combined with any caller-supplied
 * `AbortSignal`), validates the response against the matching zod schema,
 * and maps non-2xx responses through `agentCoreErrorFor`. Structurally
 * mirrors `HttpPayCoreClient`
 * (`packages/durable-ledger/src/adapters/http/pay-core-client.ts`).
 */
export class HttpDurableLedgerClient implements AgentCoreClient {
  readonly name = "durable-ledger-http";
  private readonly baseUrl: string;

  constructor(private readonly options: HttpDurableLedgerClientOptions) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl.slice(0, -1)
      : options.baseUrl;
  }

  async startPaymentWorkflow(
    req: StartPaymentWorkflowRequest,
    opts?: StartPaymentWorkflowOptions,
  ): Promise<StartPaymentWorkflowResult> {
    const result = await this.request({
      operation: "start_payment_workflow",
      method: "POST",
      path: "/workflows/payment",
      body: { ...req },
      schema: startPaymentWorkflowResponseSchema,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      idempotencyKey: opts?.idempotencyKey,
    });
    return { eventId: result.eventId };
  }

  async getRunStatus(
    eventId: string,
    opts?: RequestOptions,
  ): Promise<WorkflowRunSnapshot> {
    return this.request({
      operation: "get_run_status",
      method: "GET",
      path: `/workflows/${encodeURIComponent(eventId)}`,
      body: undefined,
      schema: workflowRunSnapshotSchema,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      idempotencyKey: undefined,
    });
  }

  private async request<T>(params: RequestParams<T>): Promise<T> {
    const { operation, method, path, body, schema } = params;
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.serviceSecret !== undefined) {
      headers["X-Service-Secret"] = this.options.serviceSecret;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    // Validated and set BEFORE any fetch call — never let an invalid key
    // reach `fetch()` itself. A key containing a control character or a
    // non-ASCII byte would make the real `fetch()` call throw a raw
    // `TypeError` (invalid header value), which `classifyFetchError` below
    // has no way to distinguish from a genuine transport failure — it would
    // be mis-classified as a retryable `AgentCoreNetworkError`, turning a
    // permanent caller bug (a malformed key) into an infinite retry loop.
    // Local validation, matching durable-ledger's own adapter-level
    // `IDEMPOTENCY_KEY_SHAPE` duplication (ADR-0013), closes that off.
    if (params.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY_SHAPE.test(params.idempotencyKey)) {
        throw new AgentCoreBadRequestError(
          "idempotencyKey must be 1-200 printable ASCII characters with no spaces",
          { operation, status: undefined, ledgerCode: undefined },
        );
      }
      headers["Idempotency-Key"] = params.idempotencyKey;
    }

    const timeoutMs =
      params.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutSignal = AbortSignalStatics.timeout(timeoutMs);
    const callerSignal = params.signal;
    const combinedSignal =
      callerSignal === undefined
        ? timeoutSignal
        : AbortSignalStatics.any([timeoutSignal, callerSignal]);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combinedSignal,
      });
    } catch (err) {
      throw this.classifyFetchError(
        operation,
        err,
        combinedSignal,
        callerSignal,
        timeoutMs,
      );
    }

    const bodyText = await response.text();

    if (!response.ok) {
      throw agentCoreErrorFor(operation, {
        status: response.status,
        bodyText,
      });
    }

    return this.parseSuccess(operation, response.status, bodyText, schema);
  }

  private parseSuccess<T>(
    operation: AgentCoreOperation,
    status: number,
    bodyText: string,
    schema: ZodType<T>,
  ): T {
    let json: unknown;
    try {
      json = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
    } catch {
      throw new AgentCoreMalformedResponseError(
        `durable-ledger ${operation} returned a ${status} response with a non-JSON body`,
        { operation, status, ledgerCode: undefined },
      );
    }

    const result = schema.safeParse(json);
    if (!result.success) {
      throw new AgentCoreMalformedResponseError(
        `durable-ledger ${operation} returned a ${status} response that did not match the expected schema`,
        { operation, status, ledgerCode: undefined },
      );
    }
    return result.data;
  }

  /**
   * `fetch` rejected before any response arrived. `combinedSignal.aborted`
   * distinguishes an abort-caused rejection (ours or the caller's) from a
   * genuine transport failure (connection refused, DNS, socket reset) —
   * only an abort sets it. Among aborts, `callerSignal.aborted` tells us
   * WHICH signal fired: the caller's own `AbortSignal` (canceled, terminal)
   * or our timeout (retryable) — never confused with one another.
   */
  private classifyFetchError(
    operation: AgentCoreOperation,
    err: unknown,
    combinedSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): AgentCoreClientError {
    if (combinedSignal.aborted) {
      if (callerSignal !== undefined && callerSignal.aborted) {
        return new AgentCoreRequestCanceledError(
          `durable-ledger ${operation} request was canceled by the caller`,
          { operation, status: undefined, ledgerCode: undefined },
        );
      }
      return new AgentCoreTimeoutError(
        `durable-ledger ${operation} timed out after ${timeoutMs}ms`,
        { operation, status: undefined, ledgerCode: undefined },
        timeoutMs,
      );
    }
    return new AgentCoreNetworkError(
      `durable-ledger ${operation} request failed`,
      { operation, status: undefined, ledgerCode: undefined, cause: err },
    );
  }
}

/** durable-ledger's error envelope (`{"error": {code, message, details?}}`) — see `server-error-mapper.ts`. */
interface LedgerErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details?: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;
}

/**
 * Same `exactOptionalPropertyTypes`-vs-zod-optional-field cast
 * `pay-core-schemas.ts`'s `errorEnvelopeSchema` uses: zod v3 infers an
 * optional field's output type as `T | undefined`, which this project's
 * `exactOptionalPropertyTypes` rejects against `details?: T` even though the
 * two are runtime-equivalent (zod omits the key entirely when the input
 * lacks it, it never sets it to `undefined`).
 */
const ledgerErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
}) as ZodType<LedgerErrorEnvelope>;

/** Never throws. Returns undefined for empty/non-JSON/non-conforming bodies. */
function parseErrorEnvelope(bodyText: string): LedgerErrorEnvelope | undefined {
  if (bodyText.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    return undefined;
  }
  const result = ledgerErrorEnvelopeSchema.safeParse(parsed.error);
  return result.success ? result.data : undefined;
}

/**
 * Builds the error message from ONLY the operation name and status, plus
 * durable-ledger's own `code`/`message` — never from the raw request or
 * response body, which could carry a `paymentMethodToken`. See
 * `durable-ledger-client.test.ts`'s "never leaks a token" assertions.
 */
function messageFor(
  operation: AgentCoreOperation,
  status: number,
  envelope: LedgerErrorEnvelope | undefined,
): string {
  const base = `durable-ledger ${operation} failed with status ${status}`;
  if (envelope === undefined) {
    return base;
  }
  return `${base} (${envelope.code}): ${envelope.message}`;
}

export interface RawErrorResponse {
  readonly status: number;
  readonly bodyText: string;
}

/**
 * Pure inverse of `durable-ledger`'s `server-error-mapper.ts` — that file
 * maps a domain/transport error to an HTTP response; this one maps an HTTP
 * response back to a typed client error.
 *
 * Deliberately diverges from durable-ledger's own `payCoreErrorFor`
 * (`packages/durable-ledger/src/adapters/http/error-mapper.ts`) on 404
 * handling: that mapper collapses every 404 into "not found" because every
 * one of pay-core's routes addresses a resource that can legitimately not
 * exist. Here, only a 404 on `GET /workflows/:eventId` carrying
 * `workflow_run_not_found` (the shape `app.ts`'s explicit `HttpError` throw
 * produces) means "no run for this event id" — `POST /workflows/payment`
 * can never legitimately 404 (it doesn't address an existing resource by
 * id), and a bare `not_found` (`app.notFound`'s shape, e.g. from a
 * misconfigured `baseUrl` hitting an unmatched route) is not a domain
 * outcome either. Collapsing either of those into `AgentCoreRunNotFoundError`
 * would disguise a base-URL misconfiguration as a legitimate "run not
 * found" answer, so both fall through to `AgentCoreUnexpectedResponseError`
 * instead.
 */
export function agentCoreErrorFor(
  operation: AgentCoreOperation,
  raw: RawErrorResponse,
): AgentCoreClientError {
  const envelope = parseErrorEnvelope(raw.bodyText);
  const message = messageFor(operation, raw.status, envelope);
  const ctx = {
    operation,
    status: raw.status,
    ledgerCode: envelope?.code,
  };

  if (
    raw.status === 400 &&
    (envelope?.code === "validation_failed" ||
      envelope?.code === "invalid_json")
  ) {
    return new AgentCoreBadRequestError(message, ctx, envelope.details);
  }

  if (
    raw.status === 404 &&
    operation === "get_run_status" &&
    envelope?.code === "workflow_run_not_found"
  ) {
    return new AgentCoreRunNotFoundError(message, ctx);
  }

  if (raw.status === 503 && envelope?.code === "workflow_engine_unavailable") {
    return new AgentCoreUnavailableError(message, ctx);
  }

  return new AgentCoreUnexpectedResponseError(message, ctx);
}
