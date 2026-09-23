/**
 * The port `adapters/persistence/drizzle/pg-grant-store.ts` implements.
 * Every mutating method here is a SINGLE atomic SQL statement (an
 * `UPDATE ... WHERE ... RETURNING`, never a read-then-decide-then-write
 * pair) — this repo already carries one accepted check-then-act race
 * (ADR-0019, the daily rate limit's TOCTOU); this port must not introduce a
 * second one. See `docs/todo/05-orchestra.md §4` for the exact SQL shape
 * each method compiles to.
 */
import type { Grant } from "../domain/grant.js";

export interface CreateGrantInput {
  readonly jti: string;
  readonly expiresAt: Date;
  readonly maxCalls: number;
}

export interface GrantStore {
  /** Inserts a brand-new grant row. `jti` must not already exist — callers mint a fresh UUID per grant. */
  create(input: CreateGrantInput): Promise<Grant>;

  /** Read-only lookup. Never used to decide whether a claim/bind will succeed — that would reintroduce the check-then-act race this port exists to avoid; use `claimCall`/`bindSession` for anything that gates a decision. */
  findByJti(jti: string): Promise<Grant | null>;

  /**
   * Atomically binds `jti` to `sessionId` on first open: one `UPDATE ...
   * WHERE jti = $1 AND bound_session_id IS NULL AND expires_at > now()
   * RETURNING *`. Succeeds (returns the updated `Grant`) only when the row
   * exists, is unexpired, and was NOT already bound to a DIFFERENT session
   * — a second browser opening an already-bound grant link gets `null`
   * here, which the HTTP layer maps to 404 (`gateway-app.ts`). Binding is
   * intentionally one-shot: even the legitimate first opener re-visiting
   * the raw `/grant/:token` link a second time gets `null` (the link is
   * "spent" once opened) — their already-issued cookie keeps working
   * independently of this method.
   */
  bindSession(jti: string, sessionId: string, now: Date): Promise<Grant | null>;

  /**
   * Atomically claims one call: `UPDATE ... WHERE jti = $1 AND used_calls <
   * max_calls AND expires_at > now() RETURNING used_calls, max_calls`. Zero
   * rows updated (returns `null`) means refuse — the caller (`gateway-app.ts`)
   * must respond 429, never silently fall back to the mock instance.
   */
  claimCall(jti: string, now: Date): Promise<Grant | null>;
}

/** The independent, grant-agnostic global backstop (`orchestra.live_budget`) — one row per UTC day. Counted alongside, never instead of, the per-grant budget above. */
export interface LiveBudgetStore {
  /**
   * Atomically claims one call against the global daily cap for `day`
   * (`YYYY-MM-DD`, UTC). Ensures a row exists (`INSERT ... ON CONFLICT (day)
   * DO NOTHING`), then atomically increments it only if `used_calls < cap`
   * (`UPDATE ... WHERE day = $1 AND used_calls < $2 RETURNING used_calls`) —
   * the two-statement shape is still race-free: the ensure-row step is
   * idempotent and order-independent, and the actual gating decision is the
   * single atomic `UPDATE`. Returns `null` when the cap is already reached.
   */
  claimCall(day: string, cap: number): Promise<{ usedCalls: number } | null>;
}
