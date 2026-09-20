import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  IdempotencyConflictError,
  IntentDerivationCollisionError,
  SubmitIntent,
  SubmitIntentCommand,
} from "./submit-intent.js";
import { deriveIntentId } from "./derive-intent-id.js";
import { GetIntent } from "./get-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import type { LlmClient, LlmReasoningRequest } from "../ports/llm-client.js";
import { LlmUnavailableError } from "../ports/llm-client.js";
import {
  IntentAlreadyExistsError,
  type IntentRepository,
  type StoredIntent,
} from "../ports/intent-repository.js";
import { Intent } from "../domain/intent.js";
import {
  paymentProposal,
  type AgentProposal,
} from "../domain/agent-proposal.js";
import type { AllowVerdict } from "../policy/verdict.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");
const ALLOW_VERDICT: AllowVerdict = { decision: "allow" };

/** A repository whose `update()` throws — used to prove `SubmitIntent` never calls it. */
class NoUpdateRepository extends InMemoryIntentRepository {
  override async update(
    _intent: Intent,
    _expectedVersion: number,
  ): Promise<StoredIntent> {
    throw new Error("update() must not be called by SubmitIntent");
  }
}

/** Counts calls to `reason()` and `create()` — used to prove a replay makes neither. Mirrors `answer-clarification.test.ts`'s `CountingLlmClient`. */
class CountingLlmClient implements LlmClient {
  readonly name: string;
  calls = 0;
  constructor(private readonly inner: LlmClient) {
    this.name = inner.name;
  }
  async reason(input: LlmReasoningRequest): Promise<AgentProposal> {
    this.calls += 1;
    return this.inner.reason(input);
  }
}

/** Counts calls to `create()` — used to prove a replay writes nothing. */
class CreateCountingRepository extends InMemoryIntentRepository {
  createCalls = 0;
  override async create(intent: Intent): Promise<StoredIntent> {
    this.createCalls += 1;
    return super.create(intent);
  }
}

/** A repository whose `create()` always throws `IntentAlreadyExistsError`, regardless of id — used to force a `randomUUID()` collision on the unkeyed path. */
class AlwaysExistsRepository extends InMemoryIntentRepository {
  override async create(intent: Intent): Promise<StoredIntent> {
    throw new IntentAlreadyExistsError(intent.id);
  }
}

/**
 * A repository that performs one competing out-of-band `create()`, via
 * `race`, the first time `create()` is called — BEFORE delegating to the
 * real (in-memory) `create()`. Used to deterministically construct a
 * same-key concurrent-create race without racing two `execute()` calls with
 * `Promise.allSettled`. Mirrors `reject-intent.test.ts`'s
 * `RaceOnUpdateIntentRepository`, applied to `create()` instead of
 * `update()`.
 */
class RaceOnCreateIntentRepository extends InMemoryIntentRepository {
  private hasRaced = false;
  /** Set after construction (it typically needs to close over this same instance). */
  race: (() => Promise<void>) | null = null;

  override async create(intent: Intent): Promise<StoredIntent> {
    if (!this.hasRaced && this.race) {
      this.hasRaced = true;
      await this.race();
    }
    return super.create(intent);
  }
}

/** Seeds a `completed` intent directly via the domain API + repository, for daily-rate-limit tests. */
async function seedCompletedIntent(
  repo: IntentRepository,
  params: { id: string; customerId: string; now: Date },
): Promise<void> {
  const intent = Intent.submit({
    id: params.id,
    customerId: params.customerId,
    text: "Pay the vendor $10.00 for the invoice.",
    now: params.now,
  });
  intent.propose(
    paymentProposal({
      amount: 1_000,
      currency: "USD",
      merchantId: "vendor-1",
      reasoning: "Invoice states $10.00.",
    }),
    params.now,
  );
  intent.autoApprove(
    { verdict: ALLOW_VERDICT, durableLedgerEventId: `evt_${params.id}` },
    params.now,
  );
  intent.complete(params.now);
  await repo.create(intent);
}

describe("SubmitIntent", () => {
  let repo: InMemoryIntentRepository;
  let llm: MockLlmClient;
  let seq: number;
  let useCase: SubmitIntent;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    llm = new MockLlmClient();
    seq = 0;
    useCase = new SubmitIntent(repo, llm, {}, CLOCK, () => `intent_${++seq}`);
  });

  it("happy path: unambiguous payment text is auto-allowed and stays proposed", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("proposed");
    expect(result.intent.proposal?.kind).toBe("propose_payment");
    expect(result.intent.proposal).toMatchObject({
      kind: "propose_payment",
      amount: 5_000,
    });
    expect(result.verdict).toEqual(ALLOW_VERDICT);
  });

  it("does not persist an 'allow' verdict onto the intent", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });
    expect(result.verdict?.decision).toBe("allow");
    expect(result.intent.policyVerdict).toBeNull();
    expect(result.intent.durableLedgerEventId).toBeNull();

    const get = new GetIntent(repo);
    const reread = await get.execute(result.intent.id);
    expect(reread.status).toBe("proposed");
    expect(reread.policyVerdict).toBeNull();
  });

  it("ambiguous amount: resolves to the minimum of the two candidates (mock's default safe-interpretation heuristic)", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor either $30.00 or $50.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.proposal).toMatchObject({
      kind: "propose_payment",
      amount: 3_000,
    });
    expect(result.verdict?.decision).toBe("allow");
  });

  it("clarification directive: status becomes needs_clarification, verdict is null", async () => {
    const result = await useCase.execute({
      text: "Please handle my payment. sim.clarify",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("needs_clarification");
    expect(result.intent.proposal?.kind).toBe("clarify");
    expect(result.verdict).toBeNull();
  });

  it("decline directive: status becomes rejected, no policyVerdict, verdict is null", async () => {
    const result = await useCase.execute({
      text: "Please handle my payment. sim.decline",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.proposal?.kind).toBe("decline");
    expect(result.intent.policyVerdict).toBeNull();
    expect(result.verdict).toBeNull();
  });

  it("grounding violation: an ungrounded proposed amount is rejected", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $100.00 for the invoice. sim.amount.ungrounded",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "amount_not_grounded",
    });
  });

  it("a merchant absent from the intent text is rejected by policy", async () => {
    const swapped = new SubmitIntent(
      repo,
      new MockLlmClient({ defaultMerchantId: "attacker-wallet-1" }),
      {},
      CLOCK,
      () => `intent_${++seq}`,
    );
    const result = await swapped.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "merchant_not_grounded",
    });
  });

  it("amount above the hard limit is rejected", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $6000.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "hard_limit_exceeded",
    });
  });

  it("disallowed currency is rejected", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $50.00 for the invoice. sim.currency.CAD",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "currency_not_allowed",
    });
  });

  it("daily rate limit: rejects when the same customer already has a completed intent within 24h", async () => {
    await seedCompletedIntent(repo, {
      id: "seed_1",
      customerId: "cust_1",
      now: CLOCK(),
    });
    const limited = new SubmitIntent(
      repo,
      llm,
      { dailyRateLimit: 1 },
      CLOCK,
      () => `intent_${++seq}`,
    );

    const result = await limited.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "daily_rate_limit_exceeded",
    });
  });

  it("daily rate limit is scoped by customerId: a different customer's completed intent does not count", async () => {
    await seedCompletedIntent(repo, {
      id: "seed_1",
      customerId: "cust_other",
      now: CLOCK(),
    });
    const limited = new SubmitIntent(
      repo,
      llm,
      { dailyRateLimit: 1 },
      CLOCK,
      () => `intent_${++seq}`,
    );

    const result = await limited.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("proposed");
    expect(result.verdict?.decision).toBe("allow");
  });

  it("approval gate: amount at/above the auto-approve threshold but below the hard limit needs approval", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $600.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.status).toBe("needs_approval");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "needs_approval",
      reason: "above_auto_approve_threshold",
    });
  });

  it("LLM unavailable: execute() rejects and no row is created for the attempted intent", async () => {
    const attemptedId = `intent_${seq + 1}`;
    await expect(
      useCase.execute({
        text: "Please handle my payment. sim.unavailable",
        customerId: "cust_1",
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);

    expect(await repo.findById(attemptedId)).toBeNull();
  });

  it("rejects blank text with a validation error and creates no row", async () => {
    await expect(
      useCase.execute({ text: "   ", customerId: "cust_1" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(seq).toBe(0);
  });

  it("rejects text over the max length with a validation error", async () => {
    await expect(
      useCase.execute({
        text: "x".repeat(10_001),
        customerId: "cust_1",
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(seq).toBe(0);
  });

  it("rejects a malformed customerId with a validation error", async () => {
    await expect(
      useCase.execute({ text: "Pay the vendor $50.00", customerId: "bad id!" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(seq).toBe(0);
  });

  it("exactly-one-write guard: never calls update() on the allow, needs_approval, or reject paths", async () => {
    const noUpdateRepo = new NoUpdateRepository();
    const guarded = new SubmitIntent(
      noUpdateRepo,
      llm,
      {},
      CLOCK,
      () => `intent_${++seq}`,
    );

    await expect(
      guarded.execute({
        text: "Pay the vendor $50.00 for the invoice.",
        customerId: "cust_1",
      }),
    ).resolves.toMatchObject({ intent: { status: "proposed" } });

    await expect(
      guarded.execute({
        text: "Pay the vendor $600.00 for the invoice.",
        customerId: "cust_1",
      }),
    ).resolves.toMatchObject({ intent: { status: "needs_approval" } });

    await expect(
      guarded.execute({
        text: "Pay the vendor $6000.00 for the invoice.",
        customerId: "cust_1",
      }),
    ).resolves.toMatchObject({ intent: { status: "rejected" } });
  });

  it("clock coherence: createdAt and updatedAt both equal the fixed clock's value", async () => {
    const result = await useCase.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    expect(result.intent.createdAt).toEqual(CLOCK());
    expect(result.intent.updatedAt).toEqual(CLOCK());
    expect(result.intent.createdAt).toEqual(result.intent.updatedAt);
  });

  it("validates a well-formed SubmitIntentCommand via the exported schema", () => {
    expect(() =>
      SubmitIntentCommand.parse({ text: "Pay $1.00", customerId: "cust_1" }),
    ).not.toThrow();
  });

  describe("idempotent submission (Idempotency-Key)", () => {
    const customerId = "cust_1";
    const idempotencyKey = "retry-key-1";
    const text = "Pay the vendor $50.00 for the invoice.";

    it("Intent.id is the deterministic derived value, not the random newId()", async () => {
      const result = await useCase.execute({
        text,
        customerId,
        idempotencyKey,
      });

      expect(result.intent.id).toBe(deriveIntentId(customerId, idempotencyKey));
      // newId() (the random-id source) was never consumed for this call.
      expect(seq).toBe(0);
    });

    it("a replay makes zero LLM calls and zero repository writes", async () => {
      const countingLlm = new CountingLlmClient(llm);
      const countingRepo = new CreateCountingRepository();
      const idempotent = new SubmitIntent(
        countingRepo,
        countingLlm,
        {},
        CLOCK,
        () => `intent_${++seq}`,
      );

      const first = await idempotent.execute({
        text,
        customerId,
        idempotencyKey,
      });
      expect(first.replayed).toBe(false);
      expect(countingLlm.calls).toBe(1);
      expect(countingRepo.createCalls).toBe(1);

      const second = await idempotent.execute({
        text,
        customerId,
        idempotencyKey,
      });
      expect(second.replayed).toBe(true);
      expect(second.intent.id).toBe(first.intent.id);
      expect(second.intent.updatedAt).toEqual(first.intent.updatedAt);
      // No new LLM call and no new write happened on the replay.
      expect(countingLlm.calls).toBe(1);
      expect(countingRepo.createCalls).toBe(1);
    });

    it("same key + different text throws IdempotencyConflictError, and the stored intent is unchanged", async () => {
      const first = await useCase.execute({ text, customerId, idempotencyKey });
      expect(first.intent.status).toBe("proposed");

      await expect(
        useCase.execute({
          text: "Pay the vendor $999.00 for a totally different invoice.",
          customerId,
          idempotencyKey,
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);

      const get = new GetIntent(repo);
      const reread = await get.execute(first.intent.id);
      expect(reread.status).toBe(first.intent.status);
      expect(reread.proposal).toEqual(first.intent.proposal);
      expect(reread.updatedAt).toEqual(first.intent.updatedAt);
    });

    it("a row at the derived id belonging to a DIFFERENT customerId throws IntentDerivationCollisionError, not a silent replay (forces the collision guard, since deriveIntentId itself can't be made to collide)", async () => {
      const id = deriveIntentId(customerId, idempotencyKey);
      // Seed a row directly at the derived id, under a different customerId
      // — the only way to exercise this guard in a test, since deriveIntentId
      // itself can't be made to actually collide.
      await repo.create(
        Intent.submit({
          id,
          customerId: "cust_other",
          text,
          now: CLOCK(),
        }),
      );

      await expect(
        useCase.execute({ text, customerId, idempotencyKey }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(IntentDerivationCollisionError);
        expect((err as IntentDerivationCollisionError).id).toBe(id);
        return true;
      });
    });

    it("no key supplied: unchanged behavior — random id, replayed always false", async () => {
      const result = await useCase.execute({ text, customerId });

      expect(result.replayed).toBe(false);
      // Came from the injected newId() (the random-id source), not any
      // deterministic formula — proven by matching the fixture's counter.
      expect(result.intent.id).toBe(`intent_${seq}`);
    });

    it("IntentAlreadyExistsError still propagates on the unkeyed path on a forced id collision", async () => {
      const collidingRepo = new AlwaysExistsRepository();
      const colliding = new SubmitIntent(
        collidingRepo,
        llm,
        {},
        CLOCK,
        () => `intent_${++seq}`,
      );

      await expect(
        colliding.execute({ text, customerId }),
      ).rejects.toBeInstanceOf(IntentAlreadyExistsError);
    });

    it("concurrent same-key create race: the losing call replays the winner's row instead of throwing", async () => {
      const racyRepo = new RaceOnCreateIntentRepository();
      const winnerLlm = new MockLlmClient();
      const winnerUseCase = new SubmitIntent(
        racyRepo,
        winnerLlm,
        {},
        CLOCK,
        () => `winner_${++seq}`,
      );
      const id = deriveIntentId(customerId, idempotencyKey);

      racyRepo.race = async () => {
        // Simulates a concurrent second request with the same
        // (customerId, idempotencyKey) winning the race to create() first.
        const winnerResult = await winnerUseCase.execute({
          text,
          customerId,
          idempotencyKey,
        });
        expect(winnerResult.intent.id).toBe(id);
        expect(winnerResult.replayed).toBe(false);
      };

      const losingUseCase = new SubmitIntent(
        racyRepo,
        llm,
        {},
        CLOCK,
        () => `loser_${++seq}`,
      );
      const losingResult = await losingUseCase.execute({
        text,
        customerId,
        idempotencyKey,
      });

      expect(losingResult.replayed).toBe(true);
      expect(losingResult.intent.id).toBe(id);

      const stored = await racyRepo.findById(id);
      expect(stored?.intent.text).toBe(text);
    });
  });
});
