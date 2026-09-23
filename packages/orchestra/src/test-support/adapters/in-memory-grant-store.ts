/**
 * Test-only in-memory implementations of `GrantStore`/`LiveBudgetStore`,
 * mirroring `PgGrantStore`/`PgLiveBudgetStore`'s exact predicate logic
 * (same `usedCalls < maxCalls`, `expiresAt > now`, `boundSessionId IS NULL
 * OR === sessionId` checks) so `gateway-app.test.ts` exercises the SAME
 * gating behaviour the real Postgres-backed store enforces, without a
 * database. JS's single-threaded execution makes each method trivially
 * atomic here — the concurrency guarantee itself is proven separately, only
 * against real Postgres, by `pg-grant-store.integration.test.ts`.
 */
import { Grant } from "../../domain/grant.js";
import type {
  CreateGrantInput,
  GrantStore,
  LiveBudgetStore,
} from "../../ports/grant-store.js";

interface MutableGrantRow {
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
  maxCalls: number;
  usedCalls: number;
  boundSessionId: string | null;
}

export class InMemoryGrantStore implements GrantStore {
  readonly #rows = new Map<string, MutableGrantRow>();
  readonly #clock: () => Date;

  /** `clock` defaults to the real wall clock, matching `PgGrantStore`'s reliance on Postgres's own `now()`/`default now()` for `issuedAt` — override it in a test that also fixes the gateway app's own `clock` to a specific instant, or `create()`'s real-time `issuedAt` can race ahead of a test's fictional, fixed `now` and trip the `expiresAt > issuedAt` invariant. */
  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock;
  }

  async create(input: CreateGrantInput): Promise<Grant> {
    const row: MutableGrantRow = {
      jti: input.jti,
      issuedAt: this.#clock(),
      expiresAt: input.expiresAt,
      maxCalls: input.maxCalls,
      usedCalls: 0,
      boundSessionId: null,
    };
    this.#rows.set(input.jti, row);
    return toGrant(row);
  }

  async findByJti(jti: string): Promise<Grant | null> {
    const row = this.#rows.get(jti);
    return row ? toGrant(row) : null;
  }

  async bindSession(
    jti: string,
    sessionId: string,
    now: Date,
  ): Promise<Grant | null> {
    const row = this.#rows.get(jti);
    if (!row || row.boundSessionId !== null || row.expiresAt <= now) {
      return null;
    }
    row.boundSessionId = sessionId;
    return toGrant(row);
  }

  async claimCall(jti: string, now: Date): Promise<Grant | null> {
    const row = this.#rows.get(jti);
    if (!row || row.usedCalls >= row.maxCalls || row.expiresAt <= now) {
      return null;
    }
    row.usedCalls += 1;
    return toGrant(row);
  }
}

export class InMemoryLiveBudgetStore implements LiveBudgetStore {
  readonly #days = new Map<string, number>();

  async claimCall(
    day: string,
    cap: number,
  ): Promise<{ usedCalls: number } | null> {
    const current = this.#days.get(day) ?? 0;
    if (current >= cap) {
      return null;
    }
    const next = current + 1;
    this.#days.set(day, next);
    return { usedCalls: next };
  }
}

function toGrant(row: MutableGrantRow): Grant {
  return Grant.create({ ...row });
}
