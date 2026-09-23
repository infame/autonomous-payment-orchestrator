import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgGrantStore, PgLiveBudgetStore } from "./pg-grant-store.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Real Postgres. The load-bearing case here is concurrency: N parallel
 * `claimCall`s against a grant with `maxCalls = 1` must yield EXACTLY one
 * success — this is the entire reason `claimCall` is a single atomic
 * `UPDATE ... WHERE ... RETURNING` and not a read-then-write pair (see
 * `ports/grant-store.ts`'s header, and ADR-0019 for what happens when this
 * discipline is skipped).
 */
describe.skipIf(!hasTestDb)("PgGrantStore (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();

  function futureDate(msFromNow: number): Date {
    return new Date(Date.now() + msFromNow);
  }

  it("N parallel claimCall()s against maxCalls=1 yield exactly one success", async () => {
    const store = new PgGrantStore(db);
    const jti = randomUUID();
    await store.create({ jti, expiresAt: futureDate(60_000), maxCalls: 1 });

    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.claimCall(jti, now)),
    );
    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);

    const finalGrant = await store.findByJti(jti);
    expect(finalGrant?.usedCalls).toBe(1);
    expect(finalGrant?.isExhausted()).toBe(true);
  });

  it("claimCall never succeeds against an expired grant", async () => {
    const store = new PgGrantStore(db);
    const jti = randomUUID();
    // maxCalls must be positive at creation (CHECK), so create it valid-but-
    // far-future, then move `now` past a synthetic "expiry" via a second
    // grant created already-expired isn't possible through create() (its
    // own CHECK requires expires_at > issued_at, not > now) — so instead
    // this claims against a grant whose expiry is in the near future, using
    // a `now` deliberately AFTER that expiry.
    const expiresAt = futureDate(10);
    await store.create({ jti, expiresAt, maxCalls: 5 });

    const afterExpiry = new Date(expiresAt.getTime() + 1000);
    const claimed = await store.claimCall(jti, afterExpiry);
    expect(claimed).toBeNull();

    const stored = await store.findByJti(jti);
    expect(stored?.usedCalls).toBe(0);
  });

  it("claimCall refuses once exhausted, and bindSession refuses a second session", async () => {
    const store = new PgGrantStore(db);
    const jti = randomUUID();
    await store.create({ jti, expiresAt: futureDate(60_000), maxCalls: 1 });

    const now = new Date();
    const first = await store.claimCall(jti, now);
    expect(first).not.toBeNull();
    const second = await store.claimCall(jti, now);
    expect(second).toBeNull();

    const boundFirst = await store.bindSession(jti, "session-a", now);
    expect(boundFirst?.boundSessionId).toBe("session-a");
    const boundSecond = await store.bindSession(jti, "session-b", now);
    expect(boundSecond).toBeNull();
    // The original session re-opening also fails — binding is one-shot, not
    // idempotent for re-opens (see `ports/grant-store.ts`'s `bindSession`
    // header).
    const reopenSameSession = await store.bindSession(jti, "session-a", now);
    expect(reopenSameSession).toBeNull();
  });

  it("findByJti returns null for an unknown jti", async () => {
    const store = new PgGrantStore(db);
    const result = await store.findByJti(randomUUID());
    expect(result).toBeNull();
  });
});

describe.skipIf(!hasTestDb)("PgLiveBudgetStore (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();

  it("refuses once the daily cap is reached, across days independently", async () => {
    const store = new PgLiveBudgetStore(db);
    const day = "2026-01-01";

    const first = await store.claimCall(day, 2);
    expect(first?.usedCalls).toBe(1);
    const second = await store.claimCall(day, 2);
    expect(second?.usedCalls).toBe(2);
    const third = await store.claimCall(day, 2);
    expect(third).toBeNull();

    // A different day is an independent budget.
    const otherDay = await store.claimCall("2026-01-02", 2);
    expect(otherDay?.usedCalls).toBe(1);
  });

  it("N parallel claimCall()s against cap=1 for a fresh day yield exactly one success", async () => {
    const store = new PgLiveBudgetStore(db);
    const day = "2026-02-01";
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.claimCall(day, 1)),
    );
    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });
});
