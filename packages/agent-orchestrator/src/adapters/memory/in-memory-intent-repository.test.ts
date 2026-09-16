import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  paymentProposal,
} from "../../domain/agent-proposal.js";
import { Intent } from "../../domain/intent.js";
import {
  IntentAlreadyExistsError,
  IntentVersionConflictError,
} from "../../ports/intent-repository.js";
import { InMemoryIntentRepository } from "./in-memory-intent-repository.js";

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

describe("InMemoryIntentRepository", () => {
  describe("findById", () => {
    it("returns null for an unknown id", async () => {
      const repo = new InMemoryIntentRepository();
      expect(await repo.findById(randomUUID())).toBeNull();
    });
  });

  describe("create", () => {
    it("returns version 1 for a fresh id", async () => {
      const repo = new InMemoryIntentRepository();
      const intent = submit(randomUUID());
      const stored = await repo.create(intent);
      expect(stored.version).toBe(1);
      expect(stored.intent.id).toBe(intent.id);
      expect(stored.intent.status).toBe("received");
    });

    it("throws IntentAlreadyExistsError on a duplicate id", async () => {
      const repo = new InMemoryIntentRepository();
      const id = randomUUID();
      await repo.create(submit(id));
      await expect(repo.create(submit(id))).rejects.toBeInstanceOf(
        IntentAlreadyExistsError,
      );
    });
  });

  describe("update", () => {
    it("at the correct version returns version+1 and is visible on the next findById", async () => {
      const repo = new InMemoryIntentRepository();
      const id = randomUUID();
      const created = await repo.create(submit(id));

      const intent = created.intent;
      intent.propose(proposal);
      const updated = await repo.update(intent, created.version);
      expect(updated.version).toBe(2);
      expect(updated.intent.status).toBe("proposed");

      const found = await repo.findById(id);
      expect(found?.version).toBe(2);
      expect(found?.intent.status).toBe("proposed");
      expect(found?.intent.proposal).toEqual(proposal);
    });

    it("at a stale version throws IntentVersionConflictError and leaves the stored row unmodified", async () => {
      const repo = new InMemoryIntentRepository();
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
      expect(found?.intent.proposal).toBeNull();
    });

    it("a full lifecycle round-trip preserves proposal/policyVerdict/durableLedgerEventId/timestamps", async () => {
      const repo = new InMemoryIntentRepository();
      const id = randomUUID();
      const t0 = new Date("2026-01-01T00:00:00Z");
      const created = await repo.create(submit(id, "cust_1", t0));

      let intent = created.intent;
      let version = created.version;

      const t1 = new Date("2026-01-01T00:01:00Z");
      intent.propose(proposal, t1);
      ({ intent, version } = await repo.update(intent, version));

      const t2 = new Date("2026-01-01T00:02:00Z");
      intent.autoApprove(
        { verdict: allowVerdict, durableLedgerEventId: "evt_1" },
        t2,
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
      expect(found?.intent.createdAt).toEqual(t0);
      expect(found?.intent.updatedAt).toEqual(t3);
    });
  });

  describe("isolation", () => {
    it("two findById calls on the same id return independently-mutable objects", async () => {
      const repo = new InMemoryIntentRepository();
      const id = randomUUID();
      await repo.create(submit(id));

      const first = await repo.findById(id);
      const second = await repo.findById(id);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      // Mutating one loaded Intent must not affect the sibling copy or the
      // stored row — IntentProps nests proposal/policyVerdict objects, so a
      // shallow copy would let this leak.
      first?.intent.clarify(clarifyProposal("Which invoice?"));
      expect(second?.intent.status).toBe("received");

      const reread = await repo.findById(id);
      expect(reread?.intent.status).toBe("received");
    });
  });

  describe("countCompletedSince", () => {
    async function completedIntent(
      repo: InMemoryIntentRepository,
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
      const repo = new InMemoryIntentRepository();
      const since = new Date("2026-01-01T00:00:00Z");
      const before = new Date(since.getTime() - 1000);
      const atBoundary = since;
      const after = new Date(since.getTime() + 1000);

      // cust_1: one completed before the boundary (excluded), one at the
      // boundary (included, >= is inclusive), one after (included).
      await completedIntent(repo, "cust_1", before);
      await completedIntent(repo, "cust_1", atBoundary);
      await completedIntent(repo, "cust_1", after);

      // cust_2: completed after the boundary too, but a different customer —
      // must not be counted for cust_1.
      await completedIntent(repo, "cust_2", after);

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
