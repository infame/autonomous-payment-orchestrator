import { Intent, type IntentProps } from "../../domain/intent.js";
import {
  IntentAlreadyExistsError,
  IntentVersionConflictError,
  type IntentRepository,
  type StoredIntent,
} from "../../ports/intent-repository.js";

/**
 * In-memory `IntentRepository` for tests and local demos.
 *
 * Concurrency: unlike `@apo/pay-core`'s `InMemoryPaymentRepository` (which
 * has NO locking at all — a consequence of its `save(payment)` signature
 * having nowhere to carry a version, see `ports/intent-repository.ts`'s
 * header), this adapter enforces the exact same optimistic-lock semantics
 * as `PgIntentRepository`: `update()` checks `expectedVersion` against the
 * stored version and throws `IntentVersionConflictError` on a mismatch,
 * leaving the stored row untouched. This is a deliberate divergence from
 * the pay-core precedent, made possible by this port carrying `version`
 * explicitly from the start.
 *
 * Isolation: `IntentProps` nests mutable objects (`proposal`,
 * `policyVerdict`), unlike pay-core's flat `PaymentProps` — a shallow copy
 * on read/write would let mutating one loaded `Intent` corrupt the store or
 * a sibling copy taken from the same store. Every store/load goes through
 * `structuredClone` on the plain `IntentProps` snapshot (`Intent.toState()`
 * / `Intent.fromState()`) so no two `Intent` instances — in the store or
 * handed out to two different callers — ever share nested object identity.
 */
export class InMemoryIntentRepository implements IntentRepository {
  private readonly intents = new Map<
    string,
    { state: IntentProps; version: number }
  >();

  async findById(id: string): Promise<StoredIntent | null> {
    const stored = this.intents.get(id);
    if (!stored) {
      return null;
    }
    return {
      intent: Intent.fromState(structuredClone(stored.state)),
      version: stored.version,
    };
  }

  async create(intent: Intent): Promise<StoredIntent> {
    if (this.intents.has(intent.id)) {
      throw new IntentAlreadyExistsError(intent.id);
    }
    const state = structuredClone(intent.toState());
    this.intents.set(intent.id, { state, version: 1 });
    return { intent: Intent.fromState(structuredClone(state)), version: 1 };
  }

  async update(intent: Intent, expectedVersion: number): Promise<StoredIntent> {
    const stored = this.intents.get(intent.id);
    // Nothing ever deletes an entry, so a missing entry or a version
    // mismatch both surface as the same conflict — the caller must have
    // read a stale (or non-existent) version.
    if (!stored || stored.version !== expectedVersion) {
      throw new IntentVersionConflictError(intent.id, expectedVersion);
    }
    const state = structuredClone(intent.toState());
    const version = expectedVersion + 1;
    this.intents.set(intent.id, { state, version });
    return { intent: Intent.fromState(structuredClone(state)), version };
  }

  async countCompletedSince(customerId: string, since: Date): Promise<number> {
    let count = 0;
    for (const { state } of this.intents.values()) {
      if (
        state.customerId === customerId &&
        state.status === "completed" &&
        state.updatedAt >= since
      ) {
        count += 1;
      }
    }
    return count;
  }
}
