import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type { LlmClientError } from "../../ports/llm-client.js";
import {
  LlmConfigurationError,
  LlmUnavailableError,
} from "../../ports/llm-client.js";

/**
 * Maps whatever `AnthropicMessagesApi.create` can throw to this port's
 * closed `LlmClientError` rejection set. This is the ONE place in this
 * adapter that is allowed to look at an SDK error's own fields — and even
 * here, only a narrow allowlist of them.
 *
 * ## The rule that makes this file security-relevant, not just plumbing
 *
 * `APIError#message` and `APIError#error` (the parsed JSON response body)
 * can echo request content back — a vendor 400 for a malformed tool call, for
 * instance, is entirely capable of quoting fragments of what was sent, which
 * in this adapter's case can include the customer's `intentText`. Per
 * `ports/llm-client.ts`'s header ("any error message [an adapter] builds
 * from this port's errors must never include a raw prompt, a raw vendor
 * response body, or a raw vendor error message"), every message built below
 * uses ONLY `status`, `err.type` (the vendor's own error-type discriminator,
 * e.g. `"rate_limit_error"`), and `err.requestID` — structural facts, never
 * `err.message`/`err.error`.
 *
 * `cause` is deliberately attached for the transport/unknown branches
 * (`LlmUnavailableError`, the final `AnthropicError`/unknown-throw branches)
 * but NEVER for an `APIError` branch: `APIError#error` (the response body,
 * potentially carrying echoed request content) is a property of the error
 * object itself, so attaching the `APIError` instance as `cause` would let a
 * logger that walks the cause chain reach that body even though this
 * function's own message text stayed clean. Losing a `cause` link on a
 * configuration/vendor-rejection error is an acceptable trade for that.
 *
 * ## Ordering: narrowest to broadest
 *
 * `APIConnectionTimeoutError extends APIConnectionError extends APIError`,
 * so the timeout check MUST run before the broader connection-error check,
 * which MUST run before the generic `APIError` status-based branch — an
 * `instanceof` check in the wrong order would silently produce the broader
 * class's (correct-enough but less precise) message instead.
 */
export function mapAnthropicError(err: unknown): LlmClientError {
  if (err instanceof APIConnectionTimeoutError) {
    return new LlmUnavailableError("request to LLM vendor timed out", err);
  }
  if (err instanceof APIConnectionError) {
    return new LlmUnavailableError("could not reach LLM vendor", err);
  }
  if (err instanceof APIUserAbortError) {
    return new LlmUnavailableError("request to LLM vendor was aborted", err);
  }
  if (err instanceof APIError) {
    const status = err.status as number | undefined;
    const type = err.type;
    const requestId = err.requestID;
    const detail = describeApiError(status, type, requestId);
    if (isTransportLikeStatus(status)) {
      return new LlmUnavailableError(`LLM vendor request failed (${detail})`);
    }
    return new LlmConfigurationError(
      `LLM vendor rejected the request (${detail})`,
    );
  }
  if (err instanceof AnthropicError) {
    return new LlmConfigurationError(
      "LLM client failed before sending a request (SDK-level error)",
    );
  }
  return new LlmUnavailableError("unexpected failure calling LLM vendor", err);
}

function isTransportLikeStatus(status: number | undefined): boolean {
  return (
    status === undefined || status >= 500 || status === 408 || status === 429
  );
}

/** Structural facts only — status/type/requestID. Never `err.message`/`err.error`. See file header. */
function describeApiError(
  status: number | undefined,
  type: string | null | undefined,
  requestId: string | null | undefined,
): string {
  const parts = [`status=${String(status ?? "unknown")}`];
  if (type !== null && type !== undefined) {
    parts.push(`type=${type}`);
  }
  if (requestId !== null && requestId !== undefined) {
    parts.push(`requestId=${requestId}`);
  }
  return parts.join(", ");
}
