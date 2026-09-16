import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  paymentProposal,
} from "../../../domain/agent-proposal.js";
import { Intent } from "../../../domain/intent.js";
import {
  IntentAlreadyExistsError,
  IntentVersionConflictError,
} from "../../../ports/intent-repository.js";
import { PgIntentRepository } from "./pg-intent-repository.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

const proposal = paymentProposal({
  amount: 5_000,
  currency: "USD",
  merchantId: "vendor-42",
  reasoning: "Invoice states $50.00.",
});
const allowVerdict = { decision: "allow" as const };

function submit(id: string, customerId = "cust_1", now?: Date): Intent {
  return Intent.submit({
    id,
    customerId,
    text: "Pay vendor-42 $50.00 for invoice #123.",
    ...(now !== undefined ? { now } : {}),
  });
}

/**
 * Real-Postgres suite for `PgIntentRepository`. Skipped (not silently — see
 * `test-support.ts`) unless `TEST_DATABASE_URL` is set; `pnpm test` never
 * picks this file up at all (`vitest.config.ts` excludes
 * `*.integration.test.ts`), so this guard only matters for a
 * direct/misconfigured invocation.
 */
describe.skipIf(!hasTestDb)("PgIntentRepository (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();
  const repo = new PgIntentRepository(db);

  describe("findById", () => {
    it("returns null for an unknown id", async () => {
      expect(await repo.findById(randomUUID())).toBeNull();
    });
  });

  describe("create", () => {
    it("returns version 1 for a fresh id", async () => {
      const intent = submit(randomUUID());
      const stored = await repo.create(intent);
      expect(stored.version).toBe(1);
      expect(stored.intent.status).toBe("received");
    });

    it("throws IntentAlreadyExistsError on a duplicate id", async () => {
      const id = randomUUID();
      await repo.create(submit(id));
      await expect(repo.create(submit(id))).rejects.toBeInstanceOf(
        IntentAlreadyExistsError,
      );
    });
  });

  describe("update", () => {
    it("at the correct version returns version+1 and is visible on the next findById", async () => {
      const id = randomUUID();
      const created = await repo.create(submit(id));

      const intent = created.intent;
      intent.propose(proposal);
      const updated = await repo.update(intent, created.version);
      expect(updated.version).toBe(2);

      const found = await repo.findById(id);
      expect(found?.version).toBe(2);
      expect(found?.intent.status).toBe("proposed");
      expect(found?.intent.proposal).toEqual(proposal);
    });

    it("at a stale version throws IntentVersionConflictError and leaves the stored row unmodified", async () => {
      const id = randomUUID();
      const created = await repo.create(submit(id));

      const intent = created.intent;
      intent.propose(proposal);

      await expect(
        repo.update(intent, created.version + 1),
      ).rejects.toBeInstanceOf(IntentVersionConflictError);

      const found = await repo.findById(id);
      expect(found?.version).toBe(1);
      expect(found?.intent.status).toBe("received");
    });

    it("a full lifecycle round-trip preserves proposal/policyVerdict/durableLedgerEventId/timestamps", async () => {
      const id = randomUUID();
      const t0 = new Date("2026-01-01T00:00:00Z");
      const created = await repo.create(submit(id, "cust_1", t0));

      let intent = created.intent;
      let version = created.version;

      intent.propose(proposal, new Date("2026-01-01T00:01:00Z"));
      ({ intent, version } = await repo.update(intent, version));

      intent.autoApprove(
        { verdict: allowVerdict, durableLedgerEventId: "evt_1" },
        new Date("2026-01-01T00:02:00Z"),
      );
      ({ intent, version } = await repo.update(intent, version));

      const t3 = new Date("2026-01-01T00:03:00Z");
      intent.complete(t3);
      ({ intent, version } = await repo.update(intent, version));

      const found = await repo.findById(id);
      expect(found?.version).toBe(4);
      expect(found?.intent.status).toBe("completed");
      expect(found?.intent.proposal).toEqual(proposal);
      expect(found?.intent.policyVerdict).toEqual(allowVerdict);
      expect(found?.intent.durableLedgerEventId).toBe("evt_1");
      expect(found?.intent.createdAt.getTime()).toBe(t0.getTime());
      expect(found?.intent.updatedAt.getTime()).toBe(t3.getTime());
    });

    it("concurrent updates: exactly one fulfills, one rejects with IntentVersionConflictError, final version is n+1 not n+2", async () => {
      const id = randomUUID();
      const created = await repo.create(submit(id));

      // Clone BEFORE either mutates, so intentA/intentB represent two
      // independent readers who both loaded the same `received` version 1
      // and then diverge — not one mutating the other's state.
      const intentA = created.intent;
      const intentB = Intent.fromState(created.intent.toState());
      intentA.propose(proposal);
      intentB.clarify(clarifyProposal("Which invoice?"));

      const [resultA, resultB] = await Promise.allSettled([
        repo.update(intentA, created.version),
        repo.update(intentB, created.version),
      ]);

      const outcomes = [resultA.status, resultB.status];
      expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);

      const rejected = [resultA, resultB].find((r) => r.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(IntentVersionConflictError);
      }

      const found = await repo.findById(id);
      expect(found?.version).toBe(2);
    });
  });

  describe("countCompletedSince", () => {
    /**
     * `PgIntentRepository.update()` persists whatever `updatedAt` is
     * already on the domain snapshot (see the repository's header comment)
     * — so, like the in-memory sibling test, this can inject historical
     * timestamps straight through the domain API rather than relying on
     * real wall-clock waits.
     */
    async function completedIntent(
      customerId: string,
      completedAt: Date,
    ): Promise<void> {
      const id = randomUUID();
      const created = await repo.create(submit(id, customerId, completedAt));
      let intent = created.intent;
      let version = created.version;
      intent.propose(proposal, completedAt);
      ({ intent, version } = await repo.update(intent, version));
      intent.autoApprove(
        { verdict: allowVerdict, durableLedgerEventId: `evt_${id}` },
        completedAt,
      );
      ({ intent, version } = await repo.update(intent, version));
      intent.complete(completedAt);
      await repo.update(intent, version);
    }

    it("filters by customerId, status == completed, and the since boundary (both sides)", async () => {
      const since = new Date("2026-01-01T00:00:00Z");
      const before = new Date(since.getTime() - 1000);
      const atBoundary = since;
      const after = new Date(since.getTime() + 1000);

      // cust_1: one completed before the boundary (excluded), one at the
      // boundary (included, >= is inclusive), one after (included).
      await completedIntent("cust_1", before);
      await completedIntent("cust_1", atBoundary);
      await completedIntent("cust_1", after);

      // cust_2: completed after the boundary too, but a different customer —
      // must not be counted for cust_1.
      await completedIntent("cust_2", after);

      // cust_1: a non-completed intent after the boundary — must not count.
      const id = randomUUID();
      const created = await repo.create(submit(id, "cust_1", after));
      created.intent.propose(proposal, after);
      await repo.update(created.intent, created.version);

      expect(await repo.countCompletedSince("cust_1", since)).toBe(2);
      expect(await repo.countCompletedSince("cust_2", since)).toBe(1);
      expect(await repo.countCompletedSince("cust_3", since)).toBe(0);
    });
  });
});
