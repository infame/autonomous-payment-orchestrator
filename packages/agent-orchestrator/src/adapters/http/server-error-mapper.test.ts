import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mapError, HttpError } from "./server-error-mapper.js";
import { ExecutionRaceLostError } from "../../app/approve-intent.js";
import {
  IntentNotFoundError,
  InvalidIntentError,
  InvalidIntentStateError,
  InvalidProposalError,
} from "../../domain/errors.js";
import {
  IntentAlreadyExistsError,
  IntentVersionConflictError,
} from "../../ports/intent-repository.js";
import {
  LlmConfigurationError,
  LlmProtocolError,
  LlmUnavailableError,
} from "../../ports/llm-client.js";
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

const CTX = (overrides?: {
  status?: number;
  operation?: "start_payment_workflow" | "get_run_status";
}) => ({
  operation: overrides?.operation ?? "start_payment_workflow",
  status: overrides?.status,
  ledgerCode: undefined,
});

describe("mapError", () => {
  it("1. maps a ZodError to 400 validation_failed, details carry only path/message, never the submitted value", () => {
    const schema = z.object({ amount: z.number().positive() });
    const secretValue = -999999;
    const result = schema.safeParse({ amount: secretValue });
    if (result.success) throw new Error("expected parse to fail");

    const mapped = mapError(result.error);

    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("validation_failed");
    expect(mapped.body.error.details).toBeDefined();
    for (const detail of mapped.body.error.details ?? []) {
      expect(Object.keys(detail).sort()).toEqual(["message", "path"]);
    }
    const serialized = JSON.stringify(mapped.body);
    expect(serialized).not.toContain(String(secretValue));
  });

  it("2. maps HttpError(missing_customer_id) to its own status/code/message, header value absent", () => {
    const secretHeaderValue = "not-used-in-this-error-but-checked-anyway";
    const err = new HttpError(
      400,
      "missing_customer_id",
      "X-Customer-Id header is required",
    );
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("missing_customer_id");
    expect(JSON.stringify(mapped.body)).not.toContain(secretHeaderValue);
  });

  it("3. maps HttpError(invalid_customer_id) to its own status/code/message, malformed value absent", () => {
    const malformedValue = "bad header value with a space";
    const err = new HttpError(
      400,
      "invalid_customer_id",
      "X-Customer-Id header is malformed",
    );
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("invalid_customer_id");
    expect(JSON.stringify(mapped.body)).not.toContain(malformedValue);
  });

  it("4. maps ExecutionRaceLostError to 409 execution_race_lost with durableLedgerEventId; no other case ever sets that key", () => {
    const err = new ExecutionRaceLostError("intent_1", "evt_orphaned_123");
    const mapped = mapError(err);
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe("execution_race_lost");
    expect(mapped.body.error.durableLedgerEventId).toBe("evt_orphaned_123");

    const others = [
      mapError(new IntentNotFoundError("x")),
      mapError(new InvalidIntentStateError("proposed", "approve")),
      mapError(new InvalidIntentError("bad")),
      mapError(new IntentVersionConflictError("x", 1)),
      mapError(new Error("plain")),
    ];
    for (const other of others) {
      expect(other.body.error.durableLedgerEventId).toBeUndefined();
    }
  });

  it("5. maps IntentNotFoundError to 404", () => {
    const err = new IntentNotFoundError("intent_1");
    const mapped = mapError(err);
    expect(mapped.status).toBe(404);
    expect(mapped.body.error.code).toBe("intent_not_found");
  });

  it("6. maps InvalidIntentStateError to 422", () => {
    const err = new InvalidIntentStateError("proposed", "approve");
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe("invalid_intent_state");
  });

  it("7. maps InvalidIntentError to 400", () => {
    const err = new InvalidIntentError("bad customerId");
    const mapped = mapError(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("invalid_intent");
  });

  it("8. maps IntentVersionConflictError to 409", () => {
    const err = new IntentVersionConflictError("intent_1", 1);
    const mapped = mapError(err);
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe("intent_version_conflict");
  });

  it("9. maps InvalidProposalError to 500 internal_error, original message absent", () => {
    const secretMessage = "malformed proposal detail that must not leak";
    const err = new InvalidProposalError(secretMessage);
    const mapped = mapError(err);
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("10. maps IntentAlreadyExistsError to 500 internal_error, original message absent", () => {
    const err = new IntentAlreadyExistsError("intent_1");
    const mapped = mapError(err);
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(JSON.stringify(mapped.body)).not.toContain("intent_1");
  });

  it("11. maps LlmUnavailableError to 503 llm_unavailable, fixed message, reason absent", () => {
    const secretReason = "vendor said something sensitive here";
    const err = new LlmUnavailableError(secretReason);
    const mapped = mapError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe("llm_unavailable");
    expect(mapped.body.error.message).toBe(
      "The language model is temporarily unavailable.",
    );
    expect(JSON.stringify(mapped.body)).not.toContain(secretReason);
  });

  it("12. maps LlmConfigurationError to 500 llm_configuration_error, fixed message, reason absent", () => {
    const secretReason = "bad api key xyz-secret";
    const err = new LlmConfigurationError(secretReason);
    const mapped = mapError(err);
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("llm_configuration_error");
    expect(mapped.body.error.message).toBe(
      "The language model client is misconfigured.",
    );
    expect(JSON.stringify(mapped.body)).not.toContain(secretReason);
  });

  it("13. maps LlmProtocolError to 502 llm_protocol_error, fixed message, reason absent", () => {
    const secretReason = "raw vendor response body leaked here";
    const err = new LlmProtocolError(secretReason);
    const mapped = mapError(err);
    expect(mapped.status).toBe(502);
    expect(mapped.body.error.code).toBe("llm_protocol_error");
    expect(mapped.body.error.message).toBe(
      "The language model returned an unusable response.",
    );
    expect(JSON.stringify(mapped.body)).not.toContain(secretReason);
  });

  it("14. maps AgentCoreUnavailableError to 503, distinctive message absent from body", () => {
    const secretMessage =
      "unreachable: internal host ledger-primary.acme.local";
    const err = new AgentCoreUnavailableError(
      secretMessage,
      CTX({ status: 503 }),
    );
    const mapped = mapError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe("agent_core_unavailable");
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("15. maps AgentCoreNetworkError to 503, distinctive message absent from body", () => {
    const secretMessage = "dns failed for ledger-internal.acme.local";
    const err = new AgentCoreNetworkError(secretMessage, CTX());
    const mapped = mapError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.body.error.code).toBe("agent_core_network_error");
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("16. maps AgentCoreTimeoutError to 504, message mentions the workflow may already have been accepted, distinctive message absent", () => {
    const secretMessage =
      "timed out after 5000ms calling POST /workflows/payment";
    const err = new AgentCoreTimeoutError(secretMessage, CTX(), 5000);
    const mapped = mapError(err);
    expect(mapped.status).toBe(504);
    expect(mapped.body.error.code).toBe("agent_core_timeout");
    expect(mapped.body.error.message).toMatch(/may already have been accepted/);
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("17. AgentCoreUnexpectedResponseError: retryable (5xx upstream) -> 503; non-retryable (4xx upstream) -> 502; distinctive messages absent", () => {
    const retryableSecret = 'weird 503 body: {"internal":"trace-abc123"}';
    const retryable = new AgentCoreUnexpectedResponseError(
      retryableSecret,
      CTX({ status: 503 }),
    );
    expect(retryable.retryable).toBe(true);
    const mappedRetryable = mapError(retryable);
    expect(mappedRetryable.status).toBe(503);
    expect(mappedRetryable.body.error.code).toBe(
      "agent_core_unexpected_response",
    );
    expect(JSON.stringify(mappedRetryable.body)).not.toContain(retryableSecret);

    const notRetryableSecret = 'weird 418 body: {"internal":"trace-xyz789"}';
    const notRetryable = new AgentCoreUnexpectedResponseError(
      notRetryableSecret,
      CTX({ status: 418 }),
    );
    expect(notRetryable.retryable).toBe(false);
    const mappedNotRetryable = mapError(notRetryable);
    expect(mappedNotRetryable.status).toBe(502);
    expect(mappedNotRetryable.body.error.code).toBe(
      "agent_core_unexpected_response",
    );
    expect(JSON.stringify(mappedNotRetryable.body)).not.toContain(
      notRetryableSecret,
    );
  });

  it("18. maps AgentCoreMalformedResponseError to 502, distinctive message absent from body", () => {
    const secretMessage = "bad shape: unexpected field vendorInternalTraceId";
    const err = new AgentCoreMalformedResponseError(secretMessage, CTX());
    const mapped = mapError(err);
    expect(mapped.status).toBe(502);
    expect(mapped.body.error.code).toBe("agent_core_malformed_response");
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("19. maps AgentCoreBadRequestError to 500 internal_error (never 400); extra detail fields not forwarded", () => {
    const err = new AgentCoreBadRequestError(
      "paymentMethodToken must not be blank",
      CTX({ status: 400 }),
      [{ path: "paymentMethodToken", message: "must not be blank" }],
    );
    const mapped = mapError(err);
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(JSON.stringify(mapped.body)).not.toContain("paymentMethodToken");
  });

  it("20. maps AgentCoreRunNotFoundError to 500 internal_error, distinctive message absent from body", () => {
    const secretMessage = "no run registered for eventId evt_trace_secret_1";
    const err = new AgentCoreRunNotFoundError(secretMessage, CTX());
    const mapped = mapError(err);
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal_error");
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("21. maps AgentCoreRequestCanceledError (code agent_core_canceled) to 500 internal_error, distinctive message absent from body", () => {
    const secretMessage = "caller aborted request trace-cancel-secret-2";
    const err = new AgentCoreRequestCanceledError(secretMessage, CTX());
    expect(err.code).toBe("agent_core_canceled");
    const mapped = mapError(err);
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal_error");
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("22. maps an unrecognized Error to a generic 500, exact body, secret-looking string absent", () => {
    const secretMessage = "unexpected: database credentials leaked here";
    const mapped = mapError(new Error(secretMessage));
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(JSON.stringify(mapped.body)).not.toContain(secretMessage);
  });

  it("23. maps a thrown non-Error value (a bare string) to the same generic 500", () => {
    const mapped = mapError("just a string, not even an Error");
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal_error");
  });

  it("24. ordering regression guard: ExecutionRaceLostError (an OrchestratorError subclass) still maps to 409 with its eventId, not a generic fallback", () => {
    const err = new ExecutionRaceLostError("intent_2", "evt_2");
    const mapped = mapError(err);
    expect(mapped.status).toBe(409);
    expect(mapped.body.error.code).toBe("execution_race_lost");
    expect(mapped.body.error.durableLedgerEventId).toBe("evt_2");
    // Not the generic 500 that any other unmapped OrchestratorError would fall through to.
    expect(mapped.body.error.code).not.toBe("internal_error");
  });
});
