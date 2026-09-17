import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  ApproveIntent,
  ApproveIntentCommand,
  ExecutionRaceLostError,
} from "./approve-intent.js";
import { SubmitIntent } from "./submit-intent.js";
import { GetIntent } from "./get-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { FakeAgentCoreClient } from "../adapters/memory/fake-agent-core-client.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import {
  IntentVersionConflictError,
  type IntentRepository,
  type StoredIntent,
} from "../ports/intent-repository.js";
import {
  IntentNotFoundError,
  InvalidIntentStateError,
  InvalidProposalError,
} from "../domain/errors.js";
import { AgentCoreUnavailableError } from "../ports/agent-core-client.js";
import {
  Intent,
  type IntentProps,
  type IntentStatus,
} from "../domain/intent.js";
import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
} from "../domain/agent-proposal.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");
const TOKEN = "tok_visa_test";

/**
 * A repository whose `create()` throws once seeding is done, and which
 * counts `update()` calls — used to prove `ApproveIntent` never calls
 * `create()`, and calls `update()` exactly once on the happy path and zero
 * times on every failure path that never reaches the write. Mirrors
 * `reject-intent.test.ts`'s `NoCreateAfterSeedRepository`.
 */
class NoCreateAfterSeedRepository extends InMemoryIntentRepository {
  seedingComplete = false;
  updateCalls = 0;

  override async create(intent: Intent): Promise<StoredIntent> {
    if (this.seedingComplete) {
      throw new Error("create() must not be called by ApproveIntent");
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
 * (in-memory) `update()`. Deterministically constructs a version conflict
 * without racing two `execute()` calls with `Promise.allSettled`. Mirrors
 * `reject-intent.test.ts`'s `RaceOnUpdateIntentRepository`.
 */
class RaceOnUpdateIntentRepository extends InMemoryIntentRepository {
  private hasRaced = false;
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

/**
 * A repository whose FIRST `update()` call throws a scripted, non-version-
 * conflict error (simulating a crash after `startPaymentWorkflow` succeeded
 * but before the confirming write landed) — every subsequent call delegates
 * normally. Used to pin the accepted "dud handle" limitation (see
 * `approve-intent.ts`'s class header) against the real dedup mechanism,
 * rather than assuming it away.
 */
class ThrowOnFirstUpdateRepository extends InMemoryIntentRepository {
  private updateCallCount = 0;
  firstUpdateError: Error | null = null;

  override async update(
    intent: Intent,
    expectedVersion: number,
  ): Promise<StoredIntent> {
    this.updateCallCount += 1;
    if (this.updateCallCount === 1 && this.firstUpdateError !== null) {
      throw this.firstUpdateError;
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

/** Constructs an `Intent` directly via `Intent.fromState` and persists it as-is — the only way to reach a status (`received`, or any terminal status) that no use-case in this package can naturally leave an intent at. */
async function seedFixedIntent(
  repo: IntentRepository,
  overrides: Partial<IntentProps> & { id: string },
): Promise<void> {
  const now = CLOCK();
  const props: IntentProps = {
    id: overrides.id,
    customerId: overrides.customerId ?? "cust_1",
    text: overrides.text ?? "Pay the vendor $50.00 for the invoice.",
    status: overrides.status ?? "received",
    proposal: overrides.proposal ?? null,
    policyVerdict: overrides.policyVerdict ?? null,
    durableLedgerEventId: overrides.durableLedgerEventId ?? null,
    clarificationAnswer: overrides.clarificationAnswer ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
  await repo.create(Intent.fromState(props));
}

describe("ApproveIntent", () => {
  let repo: InMemoryIntentRepository;
  let llm: MockLlmClient;
  let agentCore: FakeAgentCoreClient;
  let seq: { n: number };
  let useCase: ApproveIntent;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    llm = new MockLlmClient();
    agentCore = new FakeAgentCoreClient();
    seq = { n: 0 };
    useCase = new ApproveIntent(repo, agentCore, TOKEN, CLOCK);
  });

  it("happy path: needs_approval -> executing, durableLedgerEventId matches the fake's minted eventId, updatedAt is the clock's value", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("executing");
    expect(result.id).toBe(intentId);
    expect(agentCore.calls).toHaveLength(1);
    const [call] = agentCore.calls;
    expect(call).toBeDefined();
    expect(result.durableLedgerEventId).toBe(call?.eventId);
    expect(result.updatedAt).toEqual(CLOCK());
  });

  it("exactly-one-write guard: never calls create(), calls update() exactly once, one startPaymentWorkflow call", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const intentId = await seedNeedsApproval(guardedRepo, llm, seq);
    guardedRepo.seedingComplete = true;
    guardedRepo.updateCalls = 0;

    const guardedUseCase = new ApproveIntent(
      guardedRepo,
      agentCore,
      TOKEN,
      CLOCK,
    );
    await expect(guardedUseCase.execute({ intentId })).resolves.toMatchObject({
      status: "executing",
    });

    expect(guardedRepo.updateCalls).toBe(1);
    expect(agentCore.calls).toHaveLength(1);
  });

  it("request-shape correctness: amount/currency/merchantId come from the proposal, paymentMethodToken comes from the constructor", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);
    const get = new GetIntent(repo);
    const before = await get.execute(intentId);
    const proposal = before.proposal;
    expect(proposal?.kind).toBe("propose_payment");

    await useCase.execute({ intentId });

    const [call] = agentCore.calls;
    expect(call).toBeDefined();
    if (proposal?.kind === "propose_payment") {
      expect(call?.request).toEqual({
        amount: proposal.amount,
        currency: proposal.currency,
        merchantId: proposal.merchantId,
        paymentMethodToken: TOKEN,
      });
    }
  });

  it("the idempotency key passed to startPaymentWorkflow equals the intent's own id", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);
    await useCase.execute({ intentId });

    const [call] = agentCore.calls;
    expect(call?.idempotencyKey).toBe(intentId);
  });

  it("spec §10: re-invoking approve on an already-executing intent makes NO client call and returns the already-stored eventId", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);

    const first = await useCase.execute({ intentId });
    expect(first.status).toBe("executing");
    expect(agentCore.calls).toHaveLength(1);

    const second = await useCase.execute({ intentId });
    expect(second.status).toBe("executing");
    expect(second.durableLedgerEventId).toBe(first.durableLedgerEventId);
    // No second client call at all.
    expect(agentCore.calls).toHaveLength(1);

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("executing");
    expect(reread.durableLedgerEventId).toBe(first.durableLedgerEventId);
  });

  it("the accepted crash-window limitation: a crash between the trigger and the write leaves a dud eventId persisted, not the real one — but only one real run is ever created", async () => {
    const crashRepo = new ThrowOnFirstUpdateRepository();
    const intentId = await seedNeedsApproval(crashRepo, llm, seq);
    crashRepo.firstUpdateError = new Error("simulated crash before the write");

    const crashUseCase = new ApproveIntent(crashRepo, agentCore, TOKEN, CLOCK);
    await expect(crashUseCase.execute({ intentId })).rejects.toThrow(
      "simulated crash before the write",
    );

    // The failed write never landed — re-read the intent, still needs_approval.
    const midway = await crashRepo.findById(intentId);
    expect(midway?.intent.status).toBe("needs_approval");

    // Retry with the SAME idempotencyKey (intent.id) — Inngest-equivalent
    // dedup means this does NOT create a second real run, but DOES mint a
    // fresh (dud) eventId.
    const retried = await crashUseCase.execute({ intentId });
    expect(retried.status).toBe("executing");

    expect(agentCore.calls).toHaveLength(2);
    const [firstCall, secondCall] = agentCore.calls;
    expect(firstCall?.idempotencyKey).toBe(intentId);
    expect(secondCall?.idempotencyKey).toBe(intentId);
    expect(agentCore.runCount).toBe(1);

    // The two calls minted two DIFFERENT eventIds — this is what rules out a
    // naive "same key -> same eventId" cache, which would pass every
    // assertion above identically without actually modeling a dud handle.
    expect(firstCall?.eventId).toBeDefined();
    expect(secondCall?.eventId).toBeDefined();
    expect(secondCall?.eventId).not.toBe(firstCall?.eventId);

    // The PERSISTED eventId is literally the SECOND call's (dud) eventId...
    const persisted = await crashRepo.findById(intentId);
    expect(persisted?.intent.durableLedgerEventId).toBe(secondCall?.eventId);
    expect(persisted?.intent.durableLedgerEventId).toBe(
      retried.durableLedgerEventId,
    );
    // ...and explicitly NOT the real run's own eventId (the first call's,
    // registered as the one genuine run for this idempotencyKey).
    expect(persisted?.intent.durableLedgerEventId).not.toBe(
      agentCore.realRunEventIdFor(intentId),
    );
    expect(agentCore.realRunEventIdFor(intentId)).toBe(firstCall?.eventId);
  });

  describe("wrong status — InvalidIntentStateError, zero client calls, storage untouched", () => {
    const otherStatuses: readonly IntentStatus[] = [
      "received",
      "needs_clarification",
      "proposed",
      "rejected",
      "completed",
      "failed",
      "needs_review",
    ];

    it.each(otherStatuses)("status %s", async (status) => {
      const id = `intent_wrong_${status}`;
      const proposal =
        status === "needs_clarification"
          ? clarifyProposal("Which invoice?")
          : status === "rejected"
            ? declineProposal("nope")
            : paymentProposal({
                amount: 5_000,
                currency: "USD",
                merchantId: "demo_merchant",
                reasoning: "test fixture",
              });
      await seedFixedIntent(repo, {
        id,
        status,
        proposal: status === "received" ? null : proposal,
        durableLedgerEventId:
          status === "completed" ||
          status === "failed" ||
          status === "needs_review"
            ? "evt_seed_1"
            : null,
      });

      await expect(useCase.execute({ intentId: id })).rejects.toBeInstanceOf(
        InvalidIntentStateError,
      );
      expect(agentCore.calls).toHaveLength(0);

      const stored = await repo.findById(id);
      expect(stored?.intent.status).toBe(status);
    });
  });

  it("unknown intent id throws IntentNotFoundError; zero client calls, zero writes", async () => {
    await expect(
      useCase.execute({ intentId: "does_not_exist" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof IntentNotFoundError && err.id === "does_not_exist",
    );
    expect(agentCore.calls).toHaveLength(0);
  });

  describe("validation failures — no repository write, no client call", () => {
    it("rejects a blank intentId", async () => {
      await expect(useCase.execute({ intentId: "" })).rejects.toBeInstanceOf(
        ZodError,
      );
      expect(agentCore.calls).toHaveLength(0);
    });

    it("rejects a missing intentId", async () => {
      await expect(
        useCase.execute({} as unknown as ApproveIntentCommand),
      ).rejects.toBeInstanceOf(ZodError);
      expect(agentCore.calls).toHaveLength(0);
    });
  });

  it("client failures propagate unchanged; the intent stays needs_approval at its original version, zero update() calls; a subsequent approve (error cleared) then succeeds", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const intentId = await seedNeedsApproval(guardedRepo, llm, seq);
    guardedRepo.seedingComplete = true;
    guardedRepo.updateCalls = 0;

    const before = await guardedRepo.findById(intentId);
    expect(before?.version).toBe(1);

    agentCore.startError = new AgentCoreUnavailableError(
      "durable-ledger unreachable",
      {
        operation: "start_payment_workflow",
        status: 503,
        ledgerCode: undefined,
      },
    );

    const guardedUseCase = new ApproveIntent(
      guardedRepo,
      agentCore,
      TOKEN,
      CLOCK,
    );
    await expect(guardedUseCase.execute({ intentId })).rejects.toBeInstanceOf(
      AgentCoreUnavailableError,
    );
    expect(guardedRepo.updateCalls).toBe(0);

    const midway = await guardedRepo.findById(intentId);
    expect(midway?.intent.status).toBe("needs_approval");
    expect(midway?.version).toBe(1);

    agentCore.startError = undefined;
    const result = await guardedUseCase.execute({ intentId });
    expect(result.status).toBe("executing");
    expect(guardedRepo.updateCalls).toBe(1);
  });

  describe("version conflict — deterministic, via a beforeUpdate race hook", () => {
    it("a competing write wins the race — ApproveIntent throws ExecutionRaceLostError carrying its OWN triggered eventId, cause is the original IntentVersionConflictError", async () => {
      const racyRepo = new RaceOnUpdateIntentRepository();
      const intentId = await seedNeedsApproval(racyRepo, llm, seq);
      racyRepo.race = async () => {
        const fresh = await racyRepo.findById(intentId);
        if (!fresh) throw new Error("expected intent to exist");
        // A concurrent write, out of band — not through our AgentCoreClient
        // double, simulating some other already-in-flight approve.
        fresh.intent.approve("evt_race_winner", CLOCK());
        await racyRepo.update(fresh.intent, fresh.version);
      };

      const outer = new ApproveIntent(racyRepo, agentCore, TOKEN, CLOCK);

      await expect(outer.execute({ intentId })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(ExecutionRaceLostError);
          const raceErr = err as ExecutionRaceLostError;
          expect(raceErr.intentId).toBe(intentId);
          // The loser's OWN eventId — this outer call's own agentCore call,
          // NOT the race hook's literal "evt_race_winner".
          expect(raceErr.durableLedgerEventId).not.toBe("evt_race_winner");
          expect(agentCore.calls.map((c) => c.idempotencyKey)).toContain(
            intentId,
          );
          expect(raceErr.cause).toBeInstanceOf(IntentVersionConflictError);
          return true;
        },
      );

      const stored = await racyRepo.findById(intentId);
      expect(stored?.intent.status).toBe("executing");
      expect(stored?.intent.durableLedgerEventId).toBe("evt_race_winner");
    });

    it("variant (safety-critical): the winning concurrent write was a RejectIntent — the row ends up rejected, not executing; still throws ExecutionRaceLostError with a real, orphaned eventId; only one real run was ever created", async () => {
      const racyRepo = new RaceOnUpdateIntentRepository();
      const intentId = await seedNeedsApproval(racyRepo, llm, seq);
      racyRepo.race = async () => {
        const fresh = await racyRepo.findById(intentId);
        if (!fresh) throw new Error("expected intent to exist");
        fresh.intent.rejectByApprover(CLOCK());
        await racyRepo.update(fresh.intent, fresh.version);
      };

      const outer = new ApproveIntent(racyRepo, agentCore, TOKEN, CLOCK);
      await expect(outer.execute({ intentId })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(ExecutionRaceLostError);
          const raceErr = err as ExecutionRaceLostError;
          expect(raceErr.durableLedgerEventId).not.toBeNull();
          expect(raceErr.durableLedgerEventId.length).toBeGreaterThan(0);
          return true;
        },
      );

      const stored = await racyRepo.findById(intentId);
      expect(stored?.intent.status).toBe("rejected");
      expect(agentCore.runCount).toBe(1);
    });
  });

  it("no caller/customer scoping: approving an intent belonging to a different customerId still succeeds", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq, "cust_owner");

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("executing");
    expect(result.customerId).toBe("cust_owner");
  });

  describe("security: paymentMethodToken never leaks", () => {
    const SENTINEL = "tok_sentinel_super_secret_99999";

    it("happy path: the sentinel token never appears in the returned IntentView", async () => {
      const secureUseCase = new ApproveIntent(repo, agentCore, SENTINEL, CLOCK);
      const intentId = await seedNeedsApproval(repo, llm, seq);

      const result = await secureUseCase.execute({ intentId });
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    });

    it("client-failure path: the sentinel token never appears in the thrown error", async () => {
      const secureUseCase = new ApproveIntent(repo, agentCore, SENTINEL, CLOCK);
      const intentId = await seedNeedsApproval(repo, llm, seq);
      agentCore.startError = new AgentCoreUnavailableError(
        "durable-ledger unreachable",
        {
          operation: "start_payment_workflow",
          status: 503,
          ledgerCode: undefined,
        },
      );

      await expect(secureUseCase.execute({ intentId })).rejects.toSatisfy(
        (err: unknown) => {
          expect((err as Error).message).not.toContain(SENTINEL);
          expect(JSON.stringify(err)).not.toContain(SENTINEL);
          return true;
        },
      );
    });

    it("ExecutionRaceLostError path: the sentinel token never appears in the thrown error", async () => {
      const racyRepo = new RaceOnUpdateIntentRepository();
      const secureUseCase = new ApproveIntent(
        racyRepo,
        agentCore,
        SENTINEL,
        CLOCK,
      );
      const intentId = await seedNeedsApproval(racyRepo, llm, seq);
      racyRepo.race = async () => {
        const fresh = await racyRepo.findById(intentId);
        if (!fresh) throw new Error("expected intent to exist");
        fresh.intent.approve("evt_race_winner_2", CLOCK());
        await racyRepo.update(fresh.intent, fresh.version);
      };

      await expect(secureUseCase.execute({ intentId })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(ExecutionRaceLostError);
          expect((err as Error).message).not.toContain(SENTINEL);
          expect(JSON.stringify(err)).not.toContain(SENTINEL);
          return true;
        },
      );
    });
  });

  it("a needs_approval intent whose proposal is not a payment proposal throws InvalidProposalError; zero client calls", async () => {
    const id = "intent_bad_proposal";
    await seedFixedIntent(repo, {
      id,
      status: "needs_approval",
      proposal: clarifyProposal("Which invoice?"),
      policyVerdict: {
        decision: "needs_approval",
        reason: "above_auto_approve_threshold",
        detail: "test fixture",
      },
    });

    await expect(useCase.execute({ intentId: id })).rejects.toBeInstanceOf(
      InvalidProposalError,
    );
    expect(agentCore.calls).toHaveLength(0);
  });

  it("no policy re-evaluation: the returned view's policyVerdict is exactly the pre-approval needs_approval verdict, not null and not recomputed", async () => {
    const intentId = await seedNeedsApproval(repo, llm, seq);
    const get = new GetIntent(repo);
    const before = await get.execute(intentId);
    expect(before.policyVerdict).toMatchObject({
      decision: "needs_approval",
      reason: "above_auto_approve_threshold",
    });

    const result = await useCase.execute({ intentId });
    expect(result.policyVerdict).toEqual(before.policyVerdict);
  });

  it("blank paymentMethodToken throws immediately at construction, before execute() is ever called", () => {
    expect(() => new ApproveIntent(repo, agentCore, "   ", CLOCK)).toThrow(
      Error,
    );
    expect(() => new ApproveIntent(repo, agentCore, "   ", CLOCK)).not.toThrow(
      InvalidIntentStateError,
    );
  });
});
