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
 * A "claim before calling durable-ledger" write is structurally impossible
 * on this port: `Intent.approve`/`Intent.autoApprove` (`domain/intent.ts`)
 * both require a real `durableLedgerEventId` as an argument before they'll
 * allow the transition to `executing`, and the Postgres schema's
 * `intents_executing_requires_event_id` CHECK constraint enforces the same
 * rule at the storage boundary — neither will accept a placeholder. Only
 * `durable-ledger` can mint that id, so the order is forced to be
 * call-then-write, never claim-then-call: a use-case calls
 * `AgentCoreClient.startPaymentWorkflow` first, and only then calls
 * `update()` once with the real id in hand. The version-conditional
 * `update(intent, expectedVersion)` this port already provides is what
 * makes an approve and a concurrent reject mutually exclusive (whichever
 * write lands first wins the version, and the loser's write fails outright)
 * — but it says nothing about durable-ledger itself. Exactly-once
 * protection against a duplicate EXTERNAL trigger (a retried HTTP call, a
 * crash-and-retry, a redelivered queue message) now lives at the
 * durable-ledger boundary, via a caller-supplied `Idempotency-Key`
 * (ADR-0013 in `@apo/durable-ledger`), not in this repository or this port.
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
