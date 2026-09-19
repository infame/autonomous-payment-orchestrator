import type { Context } from "hono";
import { HttpError } from "./server-error-mapper.js";
import { CustomerIdHeader } from "./server-schemas.js";

/**
 * Reads and validates the `X-Customer-Id` header — required on every
 * `/intents*` route, exempt on `/healthz` (see ADR-0014). Two distinct
 * error codes: "you omitted it" vs "it's malformed" are different client
 * bugs. The value is NEVER echoed in either error message.
 */
export function requireCustomerId(c: Context): string {
  const raw = c.req.header("X-Customer-Id");
  if (raw === undefined || raw === "") {
    throw new HttpError(
      400,
      "missing_customer_id",
      "X-Customer-Id header is required",
    );
  }
  const result = CustomerIdHeader.safeParse(raw);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_customer_id",
      "X-Customer-Id header is malformed",
    );
  }
  return result.data;
}

/**
 * Reads and parses the request body as JSON. An empty body is not an error
 * — a route with no required body fields (approve/reject/GET) may
 * legitimately receive none — and parses to `{}`. Byte-for-byte the same
 * contract as durable-ledger's/pay-core's own `readJsonBody`
 * (`packages/durable-ledger/src/adapters/http/request.ts`,
 * `packages/pay-core/src/adapters/http/request.ts`); same shape, same
 * `HttpError`.
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}
