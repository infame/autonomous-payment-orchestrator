import type { Context } from "hono";
import { HttpError } from "./server-error-mapper.js";
import { IdempotencyKeyHeader } from "./server-schemas.js";

/**
 * Mirrors pay-core's `requireIdempotencyKey`, but optional: this route
 * accepts a trigger with no key at all (pre-existing callers), and only
 * validates one that is actually present. A present-but-blank header is a
 * client mistake, not "absent" — it is rejected, never silently ignored.
 */
export function optionalIdempotencyKey(c: Context): string | undefined {
  const raw = c.req.header("Idempotency-Key");
  return raw === undefined ? undefined : IdempotencyKeyHeader.parse(raw);
}

/**
 * Reads and parses the request body as JSON. An empty body is not an error
 * — a route with no required body fields may legitimately receive none —
 * and parses to `{}`. Copied from pay-core's own `request.ts`
 * (`packages/pay-core/src/adapters/http/request.ts`); same contract, same
 * `HttpError` shape.
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
