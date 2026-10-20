import { ExecutionEvidenceError } from "../../domain/errors.js";
import { ZodError } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CurrencyMismatchError,
  InvalidAccountError,
  InvalidMoneyError,
  LedgerError,
} from "../../domain/errors.js";
import { WorkflowEngineUnavailableError } from "../../ports/workflow-runs.js";

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Only ever set for validation failures: path + message, never the submitted value. */
    readonly details?: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>;
  };
}

/** A transport-level failure raised directly by the HTTP adapter (bad header, bad JSON, …). Mirrors pay-core's own `HttpError` shape. */
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
 * so it's directly unit-testable, same shape as pay-core's own
 * `error-mapper.ts`.
 *
 * `InvalidAccountError`/`InvalidMoneyError`/`CurrencyMismatchError` map to
 * **400**, not pay-core's usual 422-for-domain-error convention: in this
 * package's HTTP layer, those three errors only ever arise from parsing a
 * request's own path/query parameters (`LedgerAccount.parse` on `:account`,
 * `Money`'s currency check via `CurrencyQuery`) — i.e. a malformed request —
 * never from a rejected domain state transition the way pay-core's 422 cases
 * are. This is a deliberate, narrower reuse of the same error classes, not
 * an inconsistency with pay-core's convention.
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
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    };
  }

  if (err instanceof HttpError || err instanceof ExecutionEvidenceError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (
    err instanceof InvalidAccountError ||
    err instanceof InvalidMoneyError ||
    err instanceof CurrencyMismatchError
  ) {
    return {
      status: 400,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof WorkflowEngineUnavailableError) {
    return {
      status: 503,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  if (err instanceof LedgerError) {
    return {
      status: 422,
      body: { error: { code: err.code, message: err.message } },
    };
  }

  // Never leak the underlying error's own message here — it may carry
  // implementation detail (a stack frame, a raw driver error) that isn't
  // safe to hand back to a caller. Matches pay-core's own generic 500.
  return {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Internal server error" },
    },
  };
}
