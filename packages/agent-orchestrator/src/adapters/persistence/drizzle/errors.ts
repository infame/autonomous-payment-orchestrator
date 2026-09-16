/**
 * Postgres-driver error classification for the `PgIntentRepository`. Unlike
 * `@apo/durable-ledger`'s equivalent file, this one does NOT define
 * conflict-error classes of its own (`IntentVersionConflictError` /
 * `IntentAlreadyExistsError`) — those live on the port
 * (`ports/intent-repository.ts`), since the in-memory adapter must be able
 * to raise the exact same errors without ever touching Postgres. This file
 * only classifies raw driver errors into "is this a unique-violation".
 */

/**
 * Postgres error shape carrying a SQLSTATE `code` (e.g. `23505` = unique_violation).
 */
interface PgErrorLike {
  readonly code: string;
  readonly constraint?: string;
}

function hasPgErrorCode(err: unknown): err is PgErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string"
  );
}

/**
 * drizzle-orm (0.45.x, `node-postgres` driver) wraps the raw `pg` driver
 * error in its own `DrizzleQueryError` (carrying `query`/`params`), with the
 * original error — the one that actually has `.code`/`.constraint` — on
 * `.cause`. Unwrap one level so `isUniqueViolation` sees the real SQLSTATE.
 */
function pgErrorOf(err: unknown): PgErrorLike | undefined {
  if (hasPgErrorCode(err)) {
    return err;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "cause" in err &&
    hasPgErrorCode(err.cause)
  ) {
    return err.cause;
  }
  return undefined;
}

/**
 * Narrow `unknown` to "this is a Postgres unique-violation error", optionally
 * scoped to a specific constraint name (when the driver surfaces `constraint`).
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgErr = pgErrorOf(err);
  if (!pgErr || pgErr.code !== "23505") {
    return false;
  }
  if (constraint === undefined) {
    return true;
  }
  return pgErr.constraint === constraint;
}
