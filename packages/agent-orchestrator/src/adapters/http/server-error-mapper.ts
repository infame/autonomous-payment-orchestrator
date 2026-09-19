import { ZodError } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  IntentNotFoundError,
  InvalidIntentError,
  InvalidIntentStateError,
  InvalidProposalError,
} from "../../domain/errors.js";
import { ExecutionRaceLostError } from "../../app/approve-intent.js";
import {
  IntentAlreadyExistsError,
  IntentVersionConflictError,
} from "../../ports/intent-repository.js";
import { LlmClientError } from "../../ports/llm-client.js";
import { AgentCoreClientError } from "../../ports/agent-core-client.js";

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>;
    /**
     * The ONE permitted deviation from the envelope the three packages share.
     * Only ever set on `execution_race_lost`: it is the sole handle to a
     * live, money-moving durable-ledger run, and nothing can re-derive it
     * (ADR-0010/0013: no workflow_runs correlation table). `details[]`'s
     * path+message shape cannot carry it. Do not add a second field here for
     * any other reason.
     */
    readonly durableLedgerEventId?: string;
  };
}

/** A transport-level failure raised directly by the HTTP adapter (bad header, bad JSON, …). Mirrors durable-ledger's/pay-core's own `HttpError` shape. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface MappedError {
  readonly status: ContentfulStatusCode;
  readonly body: ErrorBody;
}

/**
 * Translates any error thrown by a route handler into a status code + JSON
 * envelope. Pure and Hono-independent (takes `unknown`, returns plain data)
 * so it's directly unit-testable, same shape as pay-core's/durable-ledger's
 * own `mapError`.
 *
 * ## No generic `OrchestratorError → 422` fallback
 *
 * Unlike durable-ledger's own mapper (which falls back to 422 for any
 * unrecognized `LedgerError` subclass), there is deliberately NO catch-all
 * `OrchestratorError → 422` case here. An unmapped future `OrchestratorError`
 * falls through to the final generic 500 instead — failing CLOSED, not open.
 * That's deliberate: two `OrchestratorError` subclasses already in this
 * package (`InvalidProposalError`, `IntentAlreadyExistsError`) are genuine
 * SERVER faults (a malformed proposal that slipped past `LlmClient.reason`'s
 * own contract; an id collision on `create()`), not rejected domain state
 * transitions a caller can fix by retrying differently. Mapping every
 * `OrchestratorError` to 422 by default would tell a caller "your request
 * was invalid" for something that was actually this service's own bug.
 *
 * ## Fixed messages for `LlmClientError`/`AgentCoreClientError`
 *
 * Every case below for these two port error families uses a FIXED,
 * hardcoded message — never `err.message`/`err.reason`. Both ports'
 * headers already require every error message built anywhere on their
 * boundary to avoid vendor/response detail; `.reason`/`.message` on these
 * classes can still embed vendor error text or durable-ledger's own error
 * body, ultimately derived from a customer's intent text or payment
 * request — this mapper is the last line of defense against that leaking
 * onto the wire.
 *
 * ## No `Retry-After` header
 *
 * Unlike pay-core's `mapError` (which sets `Retry-After` for a retryable
 * `ProviderError`), no case below ever sets a `headers` field — this port
 * boundary has no equivalent signal to carry one.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation_failed",
          message: "Request validation failed",
          details: err.issues.map((issue) => ({
            path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
            message: issue.message,
          })),
        },
      },
    };
  }

  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  // Checked BEFORE IntentNotFoundError/InvalidIntentStateError/
  // InvalidProposalError below: ExecutionRaceLostError IS an
  // OrchestratorError subclass, and this file has no generic
  // OrchestratorError fallback for those to share — each case here is
  // matched explicitly, in this exact order, because several of these
  // classes share the same abstract base and a re-ordering could silently
  // change which branch wins.
  if (err instanceof ExecutionRaceLostError) {
    return {
      status: 409,
      body: {
        error: {
          code: "execution_race_lost",
          message: err.message,
          durableLedgerEventId: err.durableLedgerEventId,
        },
      },
    };
  }

  if (err instanceof IntentNotFoundError) {
    return {
      status: 404,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof InvalidIntentStateError) {
    return {
      status: 422,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof InvalidIntentError) {
    return {
      status: 400,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof IntentVersionConflictError) {
    return {
      status: 409,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  // Genuine server faults, never a caller-fixable 4xx — see this function's
  // header, "No generic OrchestratorError → 422 fallback".
  if (
    err instanceof InvalidProposalError ||
    err instanceof IntentAlreadyExistsError
  ) {
    return {
      status: 500,
      body: {
        error: { code: "internal_error", message: "Internal server error" },
      },
    };
  }

  if (err instanceof LlmClientError) {
    switch (err.code) {
      case "llm_unavailable":
        return {
          status: 503,
          body: {
            error: {
              code: "llm_unavailable",
              message: "The language model is temporarily unavailable.",
            },
          },
        };
      case "llm_configuration_error":
        return {
          status: 500,
          body: {
            error: {
              code: "llm_configuration_error",
              message: "The language model client is misconfigured.",
            },
          },
        };
      case "llm_protocol_error":
        return {
          status: 502,
          body: {
            error: {
              code: "llm_protocol_error",
              message: "The language model returned an unusable response.",
            },
          },
        };
      default:
        // A future LlmClientError subclass this mapper doesn't know about
        // yet — fail closed, same reasoning as the OrchestratorError
        // fallback above.
        return {
          status: 500,
          body: {
            error: {
              code: "internal_error",
              message: "Internal server error",
            },
          },
        };
    }
  }

  if (err instanceof AgentCoreClientError) {
    switch (err.code) {
      case "agent_core_unavailable":
        return {
          status: 503,
          body: {
            error: {
              code: "agent_core_unavailable",
              message:
                "The payment execution service is temporarily unavailable.",
            },
          },
        };
      case "agent_core_network_error":
        return {
          status: 503,
          body: {
            error: {
              code: "agent_core_network_error",
              message: "The payment execution service could not be reached.",
            },
          },
        };
      case "agent_core_timeout":
        return {
          status: 504,
          body: {
            error: {
              code: "agent_core_timeout",
              message:
                "The payment execution request timed out; the workflow may already have been accepted. Re-read this intent before retrying.",
            },
          },
        };
      case "agent_core_unexpected_response":
        return {
          // Read off the actual instance, not re-derived from `.status` —
          // see the class's own header (`ports/agent-core-client.ts`) for
          // why `.retryable` is computed from the upstream status once, at
          // construction time.
          status: err.retryable ? 503 : 502,
          body: {
            error: {
              code: "agent_core_unexpected_response",
              message:
                "The payment execution service returned an unexpected response.",
            },
          },
        };
      case "agent_core_malformed_response":
        return {
          status: 502,
          body: {
            error: {
              code: "agent_core_malformed_response",
              message:
                "The payment execution service returned a response this client could not read.",
            },
          },
        };
      case "agent_core_bad_request":
        // WE sent a bad request (a client-side construction bug) — never
        // the caller's fault, so never a 400.
        return {
          status: 500,
          body: {
            error: { code: "internal_error", message: "Internal server error" },
          },
        };
      case "agent_core_run_not_found":
        return {
          status: 500,
          body: {
            error: { code: "internal_error", message: "Internal server error" },
          },
        };
      case "agent_core_canceled":
        return {
          status: 500,
          body: {
            error: { code: "internal_error", message: "Internal server error" },
          },
        };
      default:
        // A future AgentCoreClientError subclass this mapper doesn't know
        // about yet — fail closed.
        return {
          status: 500,
          body: {
            error: { code: "internal_error", message: "Internal server error" },
          },
        };
    }
  }

  // Never leak the underlying error's own message here — it may carry
  // implementation detail (a stack frame, a raw driver error) that isn't
  // safe to hand back to a caller.
  return {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Internal server error" },
    },
  };
}
