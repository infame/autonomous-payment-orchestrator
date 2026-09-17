import type { PaymentProposal } from "../domain/agent-proposal.js";

/**
 * `AgentCoreClient` is the outbound port to `durable-ledger` — the only
 * system this package ever asks to actually move money (see the README's
 * "Why there's no `pay-core` client at all"). Every mirrored type below is
 * transcribed from a specific `durable-ledger` source file, not guessed at:
 *
 *  - `WorkflowRunStatus` / `TERMINAL_WORKFLOW_RUN_STATUSES` /
 *    `WorkflowRunSnapshot` — `packages/durable-ledger/src/ports/workflow-runs.ts`
 *    (`WorkflowRunStatus`, `WorkflowRunSnapshot`).
 *  - `StartPaymentWorkflowRequest` — `packages/durable-ledger/src/workflow/events.ts`
 *    (`paymentExecuteRequestedSchema`), the exact wire body
 *    `POST /workflows/payment` validates against.
 *  - `StartPaymentWorkflowResult` — the `202 {eventId, statusUrl}` response
 *    of that same route (`packages/durable-ledger/src/adapters/http/app.ts`).
 *
 * This package never imports `@apo/durable-ledger` — no compile-time
 * coupling between the two, same reasoning as ADR-0005 (durable-ledger not
 * importing `@apo/pay-core`) and ADR-0011 (no third `Money` copy here). The
 * types above are declared independently and kept in sync by hand; a drift
 * between the two sides is caught by `durable-ledger-client.test.ts` running
 * against a fake that itself transcribes the real routes (see that file's
 * header), not by a shared import.
 *
 * ## Stateless, no de-duplication of its own — but the wire call itself is no
 * longer un-idempotent
 *
 * `AgentCoreClient` performs NO caching of its own. Since durable-ledger's
 * ADR-0013 (`docs/adr/0013-optional-trigger-idempotency-key.md`),
 * `POST /workflows/payment` accepts an optional
 * `Idempotency-Key` header — a caller-supplied key that makes Inngest create
 * AT MOST ONE workflow run no matter how many times the same key is sent
 * (`StartPaymentWorkflowOptions.idempotencyKey` below). This client is still
 * "stateless" in the sense that it holds no cache of its own to decide
 * whether to send the header — that decision, and the key itself, come from
 * the caller on every call. The domain's own rule — `Intent.autoApprove`/
 * `Intent.approve` (`domain/intent.ts`) require a `durableLedgerEventId`
 * argument before allowing the transition to `executing`, and store it in
 * the same mutation that flips `status` — is a SECOND, independent layer,
 * not the only protection: it guards against two concurrent USE-CASE calls
 * both passing the "am I allowed to trigger this" check for the same
 * `Intent`, which the durable-ledger-side key alone cannot do (it has no
 * concept of `Intent` at all). Together the two layers close both halves of
 * spec §6's exactly-once requirement; see `app/approve-intent.ts`'s header
 * for the full accounting of what is (and isn't) still guaranteed. A
 * client-side cache here would in any case be wrong-keyed: the only inputs
 * visible at this layer are `{amount, currency, merchantId,
 * paymentMethodToken}` plus the caller-supplied key, never `Intent.id`
 * itself, and a process-local cache would not survive a restart regardless.
 *
 * ## No `waitForCompletion`/polling method
 *
 * `getRunStatus` is a single HTTP call — a snapshot, not a subscription.
 * There is deliberately no blocking "wait until terminal" helper on this
 * port: per this package's own spec §7, `POST /intents` must not block until
 * the workflow finishes, so no legitimate caller of this client could ever
 * await a blocking wait here. A future use-case that wants to poll builds
 * that loop itself, outside this port, where it can also own backoff and
 * cancellation.
 *
 * ## `Intent.customerId` has no destination on the wire
 *
 * `StartPaymentWorkflowRequest` has no `customerId` field, and never will —
 * `paymentExecuteRequestedSchema` has no such field, and
 * `PostingGroup.forCapture` (`packages/durable-ledger/src/domain/entry.ts`)
 * only ever posts between `LedgerAccount.acquirerClearing()` and
 * `LedgerAccount.merchant(merchantId)`; there is no customer-side ledger
 * account for it to reach. `Intent.customerId` stays a local audit/ownership
 * field on this package's own side of the boundary.
 *
 * ## Never build an error message from the request body
 *
 * A `StartPaymentWorkflowRequest` carries `paymentMethodToken`, a payment
 * credential — see ADR-0012 for why it exists at all. No error message
 * constructed anywhere in this file or its HTTP adapter may be built from
 * the request body; only from `operation`/`status`/durable-ledger's own
 * `code`+`message` from its error envelope. Pinned by
 * `durable-ledger-client.test.ts`'s security tests.
 */

/**
 * Mirrors durable-ledger's `WorkflowRunStatus` (src/ports/workflow-runs.ts).
 * Declared independently — this package never imports `@apo/durable-ledger`
 * (no compile-time coupling, same reasoning as ADR-0005/0011). Note the
 * British spelling "cancelled", matching durable-ledger's literal union.
 */
export type WorkflowRunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export const TERMINAL_WORKFLOW_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> =
  new Set(["completed", "failed", "cancelled"]);

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_WORKFLOW_RUN_STATUSES.has(status);
}

/**
 * Field-for-field durable-ledger's `paymentExecuteRequestedSchema`
 * (src/workflow/events.ts). Deliberately has NO `customerId` — that field
 * does not exist on the wire; see `paymentWorkflowRequestFor`'s header
 * above.
 */
export interface StartPaymentWorkflowRequest {
  readonly amount: number;
  readonly currency: string;
  readonly paymentMethodToken: string;
  readonly merchantId: string;
}

/**
 * durable-ledger answers `202 {eventId, statusUrl}`. `statusUrl` is NOT
 * surfaced here — it's a relative path fully derivable from `eventId`, and
 * returning it invites resolving it against the wrong base.
 */
export interface StartPaymentWorkflowResult {
  readonly eventId: string;
}

/** Mirrors durable-ledger's `WorkflowRunSnapshot` (src/ports/workflow-runs.ts). */
export interface WorkflowRunSnapshot {
  readonly eventId: string;
  readonly runId: string | null;
  readonly status: WorkflowRunStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly needsReview: boolean;
  readonly failureMessage: string | null;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Widens startPaymentWorkflow's options only. Mirrors durable-ledger's
 * StartPaymentExecuteOptions (src/ports/workflow-runs.ts), ADR-0013.
 */
export interface StartPaymentWorkflowOptions extends RequestOptions {
  /**
   * Caller-supplied de-duplication key, sent as the Idempotency-Key header
   * and forwarded by durable-ledger to Inngest as the event id, namespaced
   * payment-execute:<merchantId>:<key>. NOT pay-core's Idempotency-Key: no
   * stored result is replayed, and a same-key/different-body retry is
   * silently DISCARDED, not 409'd. NOT a lookup handle. Must never be
   * derived from paymentMethodToken or any PII — visible in Inngest's
   * dashboard. Implementations MUST validate the shape themselves
   * (printable ASCII, no spaces/control chars, 1..200) and MUST reject a
   * blank key rather than sending it.
   */
  readonly idempotencyKey?: string;
}

export interface AgentCoreClient {
  readonly name: string;
  startPaymentWorkflow(
    req: StartPaymentWorkflowRequest,
    opts?: StartPaymentWorkflowOptions,
  ): Promise<StartPaymentWorkflowResult>;
  getRunStatus(
    eventId: string,
    opts?: RequestOptions,
  ): Promise<WorkflowRunSnapshot>;
}

export interface PaymentWorkflowRequestInput {
  readonly proposal: PaymentProposal;
  readonly paymentMethodToken: string;
}

/**
 * Builds the exact four-field wire body for `POST /workflows/payment` from a
 * domain-valid `PaymentProposal` plus a caller-supplied
 * `paymentMethodToken` — see ADR-0012 for why the token is a caller
 * argument here rather than something the LLM proposes. Deliberately never
 * reads `proposal.reasoning`: that field is human-readable narrative, never
 * data the wire body needs, same discipline `policy/rules.ts` already
 * applies to it.
 */
export function paymentWorkflowRequestFor(
  input: PaymentWorkflowRequestInput,
): StartPaymentWorkflowRequest {
  if (input.paymentMethodToken.trim().length === 0) {
    throw new AgentCoreBadRequestError("paymentMethodToken must not be blank", {
      operation: "start_payment_workflow",
      status: undefined,
      ledgerCode: undefined,
    });
  }
  return {
    amount: input.proposal.amount,
    currency: input.proposal.currency,
    paymentMethodToken: input.paymentMethodToken,
    merchantId: input.proposal.merchantId,
  };
}

export type AgentCoreOperation = "start_payment_workflow" | "get_run_status";

export interface AgentCoreErrorContext {
  readonly operation: AgentCoreOperation;
  readonly status: number | undefined;
  readonly ledgerCode: string | undefined;
  readonly cause?: unknown;
}

export abstract class AgentCoreClientError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  readonly operation: AgentCoreOperation;
  readonly status: number | undefined;
  readonly ledgerCode: string | undefined;

  constructor(message: string, ctx: AgentCoreErrorContext) {
    super(message, ctx.cause === undefined ? undefined : { cause: ctx.cause });
    this.name = new.target.name;
    this.operation = ctx.operation;
    this.status = ctx.status;
    this.ledgerCode = ctx.ledgerCode;
  }
}

/** `fetch` itself failed before any response arrived (DNS, connection refused, socket reset). Retrying may hit a healthy instance. */
export class AgentCoreNetworkError extends AgentCoreClientError {
  readonly code = "agent_core_network_error";
  readonly retryable = true;
}

/** The request's own deadline (`timeoutMs`) elapsed with no response. The workflow trigger may have landed server-side regardless — see the port header on why this client does not retry on the caller's behalf. */
export class AgentCoreTimeoutError extends AgentCoreClientError {
  readonly code = "agent_core_timeout";
  readonly retryable = true;
  readonly timeoutMs: number;

  constructor(message: string, ctx: AgentCoreErrorContext, timeoutMs: number) {
    super(message, ctx);
    this.timeoutMs = timeoutMs;
  }
}

/** The CALLER's own `AbortSignal` fired, not the request timeout. The caller asked to stop — retrying would contradict that, so this is terminal. */
export class AgentCoreRequestCanceledError extends AgentCoreClientError {
  readonly code = "agent_core_canceled";
  readonly retryable = false;
}

/** HTTP 400 — durable-ledger rejected the request shape itself (`validation_failed` / `invalid_json`, see `server-error-mapper.ts` / `request.ts`). Same bytes will fail the same way again. */
export class AgentCoreBadRequestError extends AgentCoreClientError {
  readonly code = "agent_core_bad_request";
  readonly retryable = false;
  readonly details?: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;

  constructor(
    message: string,
    ctx: AgentCoreErrorContext,
    details?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>,
  ) {
    super(message, ctx);
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** HTTP 404 on `GET /workflows/:eventId`, `workflow_run_not_found` (`app.ts`'s explicit `HttpError` throw). No run exists for that event id, and won't start existing on retry. */
export class AgentCoreRunNotFoundError extends AgentCoreClientError {
  readonly code = "agent_core_run_not_found";
  readonly retryable = false;
}

/** HTTP 503, `workflow_engine_unavailable` (`WorkflowEngineUnavailableError` mapped in `server-error-mapper.ts`) — Inngest itself could not be reached. The request may succeed if retried. No `retryAfterMs`: durable-ledger's mapper never emits one on this surface, unlike pay-core's `Retry-After` mechanism. */
export class AgentCoreUnavailableError extends AgentCoreClientError {
  readonly code = "agent_core_unavailable";
  readonly retryable = true;
}

/**
 * Any non-2xx status this client has no specific mapping for — including a
 * bare 404 (`not_found`, `app.notFound`'s shape) on EITHER route, and any
 * 404 at all on `POST /workflows/payment` (that route can never legitimately
 * 404; see `agentCoreErrorFor`'s header for why this deliberately diverges
 * from durable-ledger's own `payCoreErrorFor`, which maps every 404 to "not
 * found"). `retryable` is computed from `status`, not a fixed literal: a
 * bare 5xx may recover server-side without any change on our end, so it's
 * worth another try; an unmapped 4xx is a request-side problem retrying
 * identically won't fix. 429/408 are included as retryable in case a future
 * proxy/ingress ever emits them.
 */
export class AgentCoreUnexpectedResponseError extends AgentCoreClientError {
  readonly code = "agent_core_unexpected_response";
  readonly retryable: boolean;

  constructor(message: string, ctx: AgentCoreErrorContext) {
    super(message, ctx);
    this.retryable =
      ctx.status !== undefined &&
      (ctx.status >= 500 || ctx.status === 429 || ctx.status === 408);
  }
}

/** A 2xx response body didn't match the expected schema. A durable-ledger/client contract drift, not something a retry fixes. */
export class AgentCoreMalformedResponseError extends AgentCoreClientError {
  readonly code = "agent_core_malformed_response";
  readonly retryable = false;
}
