import type { Inngest } from "inngest";
import { z } from "zod";
import { NEEDS_REVIEW_MARKER } from "../../workflow/compensation.js";
import type { PaymentExecuteRequested } from "../../workflow/events.js";
import {
  WorkflowEngineUnavailableError,
  type StartPaymentExecuteOptions,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowRuns,
} from "../../ports/workflow-runs.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Namespaces caller keys inside Inngest's event-id space and keeps its dashboard readable. */
const DEDUPE_ID_PREFIX = "payment-execute:";

/**
 * Same shape contract as `IdempotencyKeyHeader`
 * (`../http/server-schemas.ts`) — printable ASCII, no spaces/control
 * characters, 1-200 chars — duplicated here rather than imported so this
 * adapter validates a key's *shape* on its own, independent of whether the
 * caller arrived through `request.ts`/HTTP at all. A future direct caller
 * of this port (e.g. `agent-orchestrator`'s planned `ApproveIntent`, which
 * talks to `WorkflowRuns` without going through this package's HTTP layer)
 * gets the same validation an HTTP caller gets for free, instead of a
 * silently-forwarded unvalidated string.
 */
const IDEMPOTENCY_KEY_SHAPE = /^[\x21-\x7E]{1,200}$/;

/**
 * `AbortSignal.timeout` is supported at runtime on Node 24 but not resolvable
 * on this repo's DOM-less `lib` setting — same workaround as
 * `HttpPayCoreClient` (`../http/pay-core-client.ts`), duplicated rather than
 * shared because it's two lines and the two files have no other coupling.
 */
interface AbortSignalStatics {
  timeout(milliseconds: number): AbortSignal;
}
const AbortSignalStatics = AbortSignal as unknown as typeof AbortSignal &
  AbortSignalStatics;

/**
 * Inngest's REST API answers both routes below with this envelope shape —
 * critically, the dev server responds HTTP 200 even for its OWN error cases
 * (e.g. an unknown event id), so the envelope's `status` field, not the
 * transport-level HTTP status, is what actually tells success from failure.
 * `data` is left as `unknown` here and validated separately per-route below,
 * since the two routes return different shapes under `data`.
 */
const envelopeSchema = z.object({
  data: z.unknown(),
  error: z.string().optional(),
  status: z.number().optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;

/** `GET /v1/events/:eventId/runs` — only `run_id` of the first result is used. */
const runSummarySchema = z.object({ run_id: z.string() }).passthrough();

/** `GET /v1/runs/:runId` — the authoritative status/timestamps/output for one run. */
const runDetailSchema = z
  .object({
    run_id: z.string(),
    status: z.string(),
    run_started_at: z.string().nullable().optional(),
    ended_at: z.string().nullable().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

const STATUS_MAP: Record<string, WorkflowRunStatus> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function mapStatus(raw: string): WorkflowRunStatus {
  const mapped = STATUS_MAP[raw.toLowerCase()];
  if (mapped === undefined) {
    throw new WorkflowEngineUnavailableError(
      `Inngest returned an unrecognized run status: "${raw}"`,
    );
  }
  return mapped;
}

function outputAsString(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (output === undefined) {
    return "";
  }
  try {
    return JSON.stringify(output);
  } catch {
    // Circular or otherwise unstringifiable — fall back to a stable marker
    // rather than `String(output)`, which for a plain object produces the
    // useless "[object Object]".
    return "[unstringifiable output]";
  }
}

/** The output's `message` field when it's a plain object with one, else a stringified fallback. */
function messageOf(output: unknown): string | null {
  if (output === undefined || output === null) {
    return null;
  }
  if (typeof output === "string") {
    return output;
  }
  if (
    typeof output === "object" &&
    "message" in output &&
    typeof (output as Record<string, unknown>).message === "string"
  ) {
    return (output as Record<string, unknown>).message as string;
  }
  return outputAsString(output);
}

export interface InngestWorkflowRunsOptions {
  readonly inngest: Inngest;
  readonly apiBaseUrl: string;
  readonly signingKey?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * `WorkflowRuns` against Inngest's real REST API — no `workflow_runs` table
 * of our own (coordinator decision: run status is always read live from
 * Inngest). `findByEventId` makes two sequential requests: the first
 * resolves an event id to a run id (or reports `queued`/unknown), the second
 * fetches that run's authoritative status/timestamps/output — the first
 * call's own `status` can be stale (e.g. it may still report `Completed`
 * after Inngest has already moved a run further), so only the second call's
 * result is ever used to build the returned snapshot.
 */
export class InngestWorkflowRuns implements WorkflowRuns {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(private readonly options: InngestWorkflowRunsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl.endsWith("/")
      ? options.apiBaseUrl.slice(0, -1)
      : options.apiBaseUrl;
  }

  async startPaymentExecute(
    data: PaymentExecuteRequested,
    options?: StartPaymentExecuteOptions,
  ): Promise<{ readonly eventId: string }> {
    const key = options?.idempotencyKey;
    if (key !== undefined) {
      if (key.trim() === "") {
        throw new Error(
          "startPaymentExecute: idempotencyKey must not be blank",
        );
      }
      if (!IDEMPOTENCY_KEY_SHAPE.test(key)) {
        throw new Error(
          "startPaymentExecute: idempotencyKey has an invalid shape (printable ASCII, no spaces/control characters, max 200 chars)",
        );
      }
    }

    // Namespaced by merchantId, not just the caller's own key: two
    // unrelated callers picking the same "natural" key (order-1, a shared
    // counter, ...) for two DIFFERENT merchants must not collide with each
    // other. This does NOT protect against the same merchant reusing the
    // same key for two genuinely different payments — see ADR-0013.
    const dedupeId =
      key !== undefined
        ? `${DEDUPE_ID_PREFIX}${data.merchantId}:${key}`
        : undefined;

    let result;
    try {
      result = await this.options.inngest.send({
        name: "payment/execute.requested",
        data,
        ...(dedupeId !== undefined ? { id: dedupeId } : {}),
      });
    } catch (err) {
      throw new WorkflowEngineUnavailableError(
        "Failed to send payment/execute.requested to Inngest",
        { cause: err },
      );
    }
    const eventId = result.ids[0];
    if (eventId === undefined) {
      throw new WorkflowEngineUnavailableError(
        "Inngest accepted the send call but returned no event id",
      );
    }
    return { eventId };
  }

  async findByEventId(eventId: string): Promise<WorkflowRunSnapshot | null> {
    const listEnvelope = await this.request(
      `/v1/events/${encodeURIComponent(eventId)}/runs`,
    );
    if (listEnvelope.status === 400) {
      return null;
    }
    this.assertHealthy(listEnvelope);

    const listResult = z.array(runSummarySchema).safeParse(listEnvelope.data);
    if (!listResult.success) {
      throw new WorkflowEngineUnavailableError(
        "Inngest returned a malformed runs-list response",
      );
    }

    const firstRun = listResult.data[0];
    if (firstRun === undefined) {
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

    const detailEnvelope = await this.request(
      `/v1/runs/${encodeURIComponent(firstRun.run_id)}`,
    );
    this.assertHealthy(detailEnvelope);

    const detailResult = runDetailSchema.safeParse(detailEnvelope.data);
    if (!detailResult.success) {
      throw new WorkflowEngineUnavailableError(
        "Inngest returned a malformed run-detail response",
      );
    }

    const detail = detailResult.data;
    const status = mapStatus(detail.status);
    const failed = status === "failed";

    return {
      eventId,
      runId: detail.run_id,
      status,
      startedAt: detail.run_started_at ?? null,
      endedAt: detail.ended_at ?? null,
      needsReview:
        failed && outputAsString(detail.output).includes(NEEDS_REVIEW_MARKER),
      failureMessage: failed ? messageOf(detail.output) : null,
    };
  }

  private assertHealthy(envelope: Envelope): void {
    if (envelope.status !== undefined && envelope.status >= 500) {
      throw new WorkflowEngineUnavailableError(
        `Inngest API responded with status ${String(envelope.status)}`,
      );
    }
  }

  private async request(path: string): Promise<Envelope> {
    const url = `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.signingKey !== undefined) {
      headers.Authorization = `Bearer ${this.options.signingKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers,
        signal: AbortSignalStatics.timeout(
          this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ),
      });
    } catch (err) {
      throw new WorkflowEngineUnavailableError(
        "Failed to reach the Inngest API",
        { cause: err },
      );
    }

    const bodyText = await response.text();
    let json: unknown;
    try {
      json = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
    } catch (err) {
      throw new WorkflowEngineUnavailableError(
        "Inngest API returned a non-JSON response",
        { cause: err },
      );
    }

    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new WorkflowEngineUnavailableError(
        "Inngest API returned a response that did not match the expected envelope",
      );
    }
    return parsed.data;
  }
}
