import { Intent } from "../domain/intent.js";
import { OrchestratorError } from "../domain/errors.js";

/**
 * Persistence port for the `Intent` aggregate. Spec step 5.
 *
 * ## Why `version` is a port-level parameter, not a domain field or a `WeakMap`
 *
 * `@apo/pay-core`'s `PgPaymentRepository` tracks the optimistic-lock version
 * in a `WeakMap<Payment, number>` keyed by the aggregate instance returned
 * from `findById` (`packages/pay-core/src/adapters/persistence/drizzle/
 * pg-payment-repository.ts`). That's a workaround forced by a `save(payment)`
 * signature that was already frozen with nowhere else to carry a version —
 * and it has a real cost: `InMemoryPaymentRepository` has no locking at all,
 * because there is no natural place in that shape to even check one. This
 * port is designed from scratch, so `version` is carried explicitly on
 * `StoredIntent` and threaded back into `update` as `expectedVersion` —
 * every implementation (Postgres AND in-memory) gets real optimistic
 * locking for free, with no hidden per-instance state.
 *
 * ## Why `findById` returns `null` rather than throwing
 *
 * Not found is a normal outcome for a lookup, not exceptional — callers
 * (future `app/*` use-cases) are the ones who know whether a missing intent
 * is actually an error in their context, and raise `IntentNotFoundError`
 * (`domain/errors.ts`) themselves. A repository that throws on every miss
 * would force every caller through a try/catch for what is often just a
 * branch.
 *
 * ## Why `countCompletedSince` exists
 *
 * It is the only way a future `SubmitIntent` use-case can supply
 * `PolicyContext.completedIntentsLast24h` to the already-implemented
 * `dailyRateLimit` policy rule (`policy/rules.ts`) — that rule needs a
 * count of a customer's already-completed intents over a trailing window,
 * which only a repository (not the domain, not the policy layer) can
 * answer.
 *
 * ## What this port does NOT guarantee
 *
 * The version check alone is NOT sufficient for exactly-once
 * `durable-ledger` calls (spec §6). A future use-case must claim (i.e.
 * conditionally `update`) the intent to `executing` BEFORE calling
 * `durable-ledger`, never after — and on an `IntentVersionConflictError`
 * from that claim, it must re-read the stored `durableLedgerEventId` and
 * return it rather than blindly retrying the call, or two racing callers
 * could each mint their own workflow run for the same intent.
 */
export interface StoredIntent {
  readonly intent: Intent;
  readonly version: number;
}

export interface IntentRepository {
  findById(id: string): Promise<StoredIntent | null>;
  create(intent: Intent): Promise<StoredIntent>;
  update(intent: Intent, expectedVersion: number): Promise<StoredIntent>;
  countCompletedSince(customerId: string, since: Date): Promise<number>;
}

/** `update()` was called with a stale `expectedVersion` — someone else wrote first. */
export class IntentVersionConflictError extends OrchestratorError {
  readonly code = "intent_version_conflict";
  constructor(
    readonly intentId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Intent "${intentId}" was not at expected version ${String(expectedVersion)} — a concurrent write won the race`,
    );
  }
}

/** `create()` was called with an id that already exists. */
export class IntentAlreadyExistsError extends OrchestratorError {
  readonly code = "intent_already_exists";
  constructor(
    readonly intentId: string,
    options?: { cause?: unknown },
  ) {
    super(`Intent "${intentId}" already exists`);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
