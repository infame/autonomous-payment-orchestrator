import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import { RejectIntent, RejectIntentCommand } from "./reject-intent.js";
import { SubmitIntent } from "./submit-intent.js";
import { AnswerClarification } from "./answer-clarification.js";
import { GetIntent } from "./get-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import {
  IntentVersionConflictError,
  type IntentRepository,
  type StoredIntent,
} from "../ports/intent-repository.js";
import {
  InvalidIntentStateError,
  IntentNotFoundError,
} from "../domain/errors.js";
import { Intent } from "../domain/intent.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

/**
 * A repository whose `create()` throws once seeding is done, and which
 * counts `update()` calls — used to prove `RejectIntent` never calls
 * `create()`, and calls `update()` exactly once on the happy path and zero
 * times on every failure path. Mirrors `answer-clarification.test.ts`'s
 * `NoCreateAfterSeedRepository`.
 */
class NoCreateAfterSeedRepository extends InMemoryIntentRepository {
  seedingComplete = false;
  updateCalls = 0;

  override async create(intent: Intent): Promise<StoredIntent> {
    if (this.seedingComplete) {
      throw new Error("create() must not be called by RejectIntent");
    }
    return super.create(intent);
  }

  override async update(
    intent: Intent,
    expectedVersion: number,
  ): Promise<StoredIntent> {
    this.updateCalls += 1;
    return super.update(intent, expectedVersion);
  }
}

/**
 * A repository that performs one competing out-of-band write, via `race`,
 * the first time `update()` is called — BEFORE delegating to the real
 * (in-memory) `update()`. Used to deterministically construct a version
 * conflict without racing two `execute()` calls with `Promise.allSettled`
 * (this use-case's `findById` → `update` has nothing awaited in between, so
 * that pattern would be flaky).
 */
class RaceOnUpdateIntentRepository extends InMemoryIntentRepository {
  private hasRaced = false;
  /** Set after construction (it typically needs to close over this same instance). */
  race: (() => Promise<void>) | null = null;

  override async update(
    intent: Intent,
    expectedVersion: number,
  ): Promise<StoredIntent> {
    if (!this.hasRaced && this.race) {
      this.hasRaced = true;
      await this.race();
    }
    return super.update(intent, expectedVersion);
  }
}

/** Submits via `SubmitIntent` with an amount that lands above the auto-approve threshold ($500) but below the hard limit ($5000) — reaches `needs_approval`. */
async function seedNeedsApproval(
  repo: IntentRepository,
  llm: MockLlmClient,
  seq: { n: number },
  customerId = "cust_1",
): Promise<string> {
  const submit = new SubmitIntent(
    repo,
    llm,
    {},
    CLOCK,
    () => `intent_${++seq.n}`,
  );
  const result = await submit.execute({
    text: "Pay the vendor $600.00 for the invoice.",
    customerId,
  });
  expect(result.intent.status).toBe("needs_approval");
  return result.intent.id;
}

/** Submits via `SubmitIntent` with a `sim.clarify` directive to reach `needs_clarification`. */
async function seedNeedsClarification(
  repo: IntentRepository,
  llm: MockLlmClient,
  seq: { n: number },
  customerId = "cust_1",
): Promise<string> {
  const submit = new SubmitIntent(
    repo,
    llm,
    {},
    CLOCK,
    () => `intent_${++seq.n}`,
  );
  const result = await submit.execute({
    text: "Please handle my payment for the vendor invoice. sim.clarify",
    customerId,
  });
  expect(result.intent.status).toBe("needs_clarification");
  return result.intent.id;
}

describe("RejectIntent", () => {
  let repo: InMemoryIntentRepository;
  let llm: MockLlmClient;
  let seq: { n: number };
  let useCase: RejectIntent;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    llm = new MockLlmClient();
    seq = { n: 0 };
    useCase = new RejectIntent(repo, CLOCK);
  });

  it("happy path: reject a needs_approval intent", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("rejected");
    expect(result.id).toBe(intentId);

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("rejected");
  });

  it("the human-rejection signature survives the round-trip: policyVerdict unchanged, proposal still propose_payment, no durableLedgerEventId", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);
    const get = new GetIntent(repo);
    const beforeReject = await get.execute(intentId);
    expect(beforeReject.policyVerdict).toMatchObject({
      decision: "needs_approval",
      reason: "above_auto_approve_threshold",
    });

    await useCase.execute({ intentId });

    const reread = await get.execute(intentId);
    expect(reread.status).toBe("rejected");
    expect(reread.policyVerdict).toEqual(beforeReject.policyVerdict);
    expect(reread.proposal?.kind).toBe("propose_payment");
    expect(reread.durableLedgerEventId).toBeNull();
  });

  it("all four rejection routes are distinguishable from persisted state alone, and none matches another's signature", async () => {
    // (a) human-rejected, via RejectIntent.
    const approvalId = await seedNeedsApproval(repo, llm, seq);
    await useCase.execute({ intentId: approvalId });

    // (b) policy-rejected, via SubmitIntent with an amount above the hard limit.
    const submit = new SubmitIntent(
      repo,
      llm,
      {},
      CLOCK,
      () => `intent_${++seq.n}`,
    );
    const policyRejected = await submit.execute({
      text: "Pay the vendor $6000.00 for the invoice.",
      customerId: "cust_1",
    });
    expect(policyRejected.intent.status).toBe("rejected");

    // (c) agent-declined on the first pass, via SubmitIntent with sim.decline.
    const agentDeclined = await submit.execute({
      text: "Please handle my payment. sim.decline",
      customerId: "cust_1",
    });
    expect(agentDeclined.intent.status).toBe("rejected");

    // (d) agent-declined after the clarification round, via AnswerClarification with sim.decline.
    const clarifyId = await seedNeedsClarification(repo, llm, seq);
    const answerUseCase = new AnswerClarification(repo, llm, {}, CLOCK);
    const postClarifyDeclined = await answerUseCase.execute({
      intentId: clarifyId,
      answer: "sim.decline",
    });
    expect(postClarifyDeclined.intent.status).toBe("rejected");

    const get = new GetIntent(repo);
    const human = await get.execute(approvalId);
    const policy = await get.execute(policyRejected.intent.id);
    const decline = await get.execute(agentDeclined.intent.id);
    const postClarify = await get.execute(clarifyId);

    // (a) human: policyVerdict?.decision === "needs_approval", proposal not a decline.
    expect(human.policyVerdict?.decision).toBe("needs_approval");
    expect(human.proposal?.kind).not.toBe("decline");

    // (b) policy: policyVerdict.decision === "reject".
    expect(policy.policyVerdict?.decision).toBe("reject");
    expect(policy.proposal?.kind).not.toBe("decline");

    // (c) agent decline, first pass: policyVerdict null, proposal decline, no clarificationAnswer.
    expect(decline.policyVerdict).toBeNull();
    expect(decline.proposal?.kind).toBe("decline");
    expect(decline.clarificationAnswer).toBeNull();

    // (d) agent decline, after clarification: policyVerdict null, proposal decline, HAS a clarificationAnswer.
    expect(postClarify.policyVerdict).toBeNull();
    expect(postClarify.proposal?.kind).toBe("decline");
    expect(postClarify.clarificationAnswer).not.toBeNull();

    // None of the four collide on their discriminating fields.
    expect(human.policyVerdict?.decision).not.toBe(
      policy.policyVerdict?.decision,
    );
    expect(decline.clarificationAnswer).not.toEqual(
      postClarify.clarificationAnswer,
    );
  });

  it("updatedAt advances, createdAt does not", async () => {
    const t0 = new Date("2026-07-01T00:00:00Z");
    const t1 = new Date("2026-07-01T01:00:00Z");
    const submit = new SubmitIntent(
      repo,
      llm,
      {},
      () => t0,
      () => `intent_${++seq.n}`,
    );
    const result = await submit.execute({
      text: "Pay the vendor $600.00 for the invoice.",
      customerId: "cust_1",
    });
    expect(result.intent.status).toBe("needs_approval");
    expect(result.intent.createdAt).toEqual(t0);
    expect(result.intent.updatedAt).toEqual(t0);

    const rejectAtT1 = new RejectIntent(repo, () => t1);
    await rejectAtT1.execute({ intentId: result.intent.id });

    const get = new GetIntent(repo);
    const reread = await get.execute(result.intent.id);
    expect(reread.createdAt).toEqual(t0);
    expect(reread.updatedAt).toEqual(t1);
  });

  describe("wrong status — InvalidIntentStateError, storage untouched", () => {
    it("proposed", async () => {
      const submit = new SubmitIntent(
        repo,
        llm,
        {},
        CLOCK,
        () => `intent_${++seq.n}`,
      );
      const result = await submit.execute({
        text: "Pay the vendor $50.00 for the invoice.",
        customerId: "cust_1",
      });
      expect(result.intent.status).toBe("proposed");

      await expect(
        useCase.execute({ intentId: result.intent.id }),
      ).rejects.toBeInstanceOf(InvalidIntentStateError);

      const get = new GetIntent(repo);
      const reread = await get.execute(result.intent.id);
      expect(reread.status).toBe("proposed");
      expect(reread.policyVerdict).toBeNull();
    });

    it("already rejected (policy hard-reject) — reject-verdict discriminator unchanged", async () => {
      const submit = new SubmitIntent(
        repo,
        llm,
        {},
        CLOCK,
        () => `intent_${++seq.n}`,
      );
      const result = await submit.execute({
        text: "Pay the vendor $6000.00 for the invoice.",
        customerId: "cust_1",
      });
      expect(result.intent.status).toBe("rejected");
      expect(result.intent.policyVerdict).toMatchObject({
        decision: "reject",
        reason: "hard_limit_exceeded",
      });

      await expect(
        useCase.execute({ intentId: result.intent.id }),
      ).rejects.toBeInstanceOf(InvalidIntentStateError);

      const get = new GetIntent(repo);
      const reread = await get.execute(result.intent.id);
      expect(reread.status).toBe("rejected");
      expect(reread.policyVerdict).toMatchObject({
        decision: "reject",
        reason: "hard_limit_exceeded",
      });
    });

    it("needs_clarification", async () => {
      const intentId = await seedNeedsClarification(repo, llm, seq);

      await expect(useCase.execute({ intentId })).rejects.toBeInstanceOf(
        InvalidIntentStateError,
      );

      const get = new GetIntent(repo);
      const reread = await get.execute(intentId);
      expect(reread.status).toBe("needs_clarification");
    });
  });

  it("unknown id throws IntentNotFoundError with a matching id", async () => {
    await expect(
      useCase.execute({ intentId: "does_not_exist" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof IntentNotFoundError && err.id === "does_not_exist",
    );
  });

  describe("version conflict — deterministic, via a beforeUpdate race hook", () => {
    it("variant A: a competing rejectByApprover wins the race — losing call throws IntentVersionConflictError, stored intent stays rejected with its verdict intact", async () => {
      const racyRepo = new RaceOnUpdateIntentRepository();
      const intentId = await seedNeedsApproval(racyRepo, llm, seq);
      racyRepo.race = async () => {
        const fresh = await racyRepo.findById(intentId);
        if (!fresh) throw new Error("expected intent to exist");
        fresh.intent.rejectByApprover(CLOCK());
        await racyRepo.update(fresh.intent, fresh.version);
      };

      const outer = new RejectIntent(racyRepo, CLOCK);
      await expect(outer.execute({ intentId })).rejects.toBeInstanceOf(
        IntentVersionConflictError,
      );

      const stored = await racyRepo.findById(intentId);
      expect(stored?.intent.status).toBe("rejected");
      expect(stored?.intent.policyVerdict).toMatchObject({
        decision: "needs_approval",
        reason: "above_auto_approve_threshold",
      });
    });

    it("variant B (safety-critical): a competing approve wins the race — losing reject throws IntentVersionConflictError, stored intent stays executing with its durableLedgerEventId intact", async () => {
      const raceEventId = "evt_race_1";

      const racyRepo = new RaceOnUpdateIntentRepository();
      const intentId = await seedNeedsApproval(racyRepo, llm, seq);
      racyRepo.race = async () => {
        const fresh = await racyRepo.findById(intentId);
        if (!fresh) throw new Error("expected intent to exist");
        fresh.intent.approve(raceEventId, CLOCK());
        await racyRepo.update(fresh.intent, fresh.version);
      };

      const outer = new RejectIntent(racyRepo, CLOCK);
      await expect(outer.execute({ intentId })).rejects.toBeInstanceOf(
        IntentVersionConflictError,
      );

      const stored = await racyRepo.findById(intentId);
      expect(stored?.intent.status).toBe("executing");
      expect(stored?.intent.durableLedgerEventId).toBe(raceEventId);
    });
  });

  it("exactly-one-write guard: never calls create(), calls update() exactly once on the happy path, zero on every failure path", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const approvalId = await seedNeedsApproval(guardedRepo, llm, seq);
    const proposed = await new SubmitIntent(
      guardedRepo,
      llm,
      {},
      CLOCK,
      () => `intent_${++seq.n}`,
    ).execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });
    guardedRepo.seedingComplete = true;

    const guardedUseCase = new RejectIntent(guardedRepo, CLOCK);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: approvalId }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(guardedRepo.updateCalls).toBe(1);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: proposed.intent.id }),
    ).rejects.toBeInstanceOf(InvalidIntentStateError);
    expect(guardedRepo.updateCalls).toBe(0);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: "does_not_exist" }),
    ).rejects.toBeInstanceOf(IntentNotFoundError);
    expect(guardedRepo.updateCalls).toBe(0);
  });

  describe("validation failures — no repository write occurs", () => {
    it("rejects an empty intentId", async () => {
      const guardedRepo = new NoCreateAfterSeedRepository();
      guardedRepo.seedingComplete = true;
      const guardedUseCase = new RejectIntent(guardedRepo, CLOCK);

      await expect(
        guardedUseCase.execute({ intentId: "" }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(guardedRepo.updateCalls).toBe(0);
    });

    it("does not throw at the Zod layer for a non-empty, non-UUID-shaped intentId — that's a repository-level 404, not a validation error", () => {
      expect(() =>
        RejectIntentCommand.parse({ intentId: "not-a-uuid-but-fine" }),
      ).not.toThrow();
    });
  });
});
