import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  AutoApproveIntent,
  AutoApproveIntentCommand,
} from "./auto-approve-intent.js";
import { ExecutionRaceLostError } from "./approve-intent.js";
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
// Matches seedProposed's/seedFixedIntent's own default customerId below.
const CUSTOMER_ID = "cust_1";
// Below the default maxAutoApproveAmount (50_000 minor units) -> "allow".
const ALLOW_TEXT = "Pay the vendor $50.00 for the invoice.";

/**
 * Submits via `SubmitIntent` with an amount comfortably below the default
 * auto-approve threshold — reaches `proposed` with an (ephemeral,
 * unpersisted) "allow" verdict, the precondition `AutoApproveIntent` acts on.
 */
async function seedProposed(
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
  const result = await submit.execute({ text: ALLOW_TEXT, customerId });
  expect(result.intent.status).toBe("proposed");
  return result.intent.id;
}

/** Constructs an `Intent` directly via `Intent.fromState` and persists it as-is — the only way to reach a status no use-case in this package can naturally leave an intent at. */
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

/**
 * A repository whose FIRST `update()` call throws a scripted version
 * conflict — used to construct a race deterministically. Mirrors
 * `approve-intent.test.ts`'s `RaceOnUpdateIntentRepository`, simplified to a
 * single scripted throw (no need for an out-of-band competing write here,
 * since we only need `execute()` to observe a conflict on its own write).
 */
class ConflictOnUpdateRepository extends InMemoryIntentRepository {
  conflictOnNextUpdate = false;
  updateCalls = 0;

  override async update(
    intent: Intent,
    expectedVersion: number,
  ): Promise<StoredIntent> {
    this.updateCalls += 1;
    if (this.conflictOnNextUpdate) {
      this.conflictOnNextUpdate = false;
      throw new IntentVersionConflictError(intent.id, expectedVersion);
    }
    return super.update(intent, expectedVersion);
  }
}

/** Counts `update()` calls without altering behaviour — used for the "zero writes" assertions. */
class CountingUpdateRepository extends InMemoryIntentRepository {
  updateCalls = 0;

  override async update(
    intent: Intent,
    expectedVersion: number,
  ): Promise<StoredIntent> {
    this.updateCalls += 1;
    return super.update(intent, expectedVersion);
  }
}

describe("AutoApproveIntent", () => {
  let repo: InMemoryIntentRepository;
  let llm: MockLlmClient;
  let agentCore: FakeAgentCoreClient;
  let seq: { n: number };
  let useCase: AutoApproveIntent;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    llm = new MockLlmClient();
    agentCore = new FakeAgentCoreClient();
    seq = { n: 0 };
    useCase = new AutoApproveIntent(repo, agentCore, TOKEN, {}, CLOCK);
  });

  it("happy path: proposed (allow) -> executing, durableLedgerEventId persisted, idempotencyKey equals intent.id", async () => {
    const intentId = await seedProposed(repo, llm, seq);

    const result = await useCase.execute({ intentId, customerId: CUSTOMER_ID });
    expect(result.intent.status).toBe("executing");
    expect(result.verdict).toEqual({ decision: "allow" });
    expect(agentCore.calls).toHaveLength(1);
    const [call] = agentCore.calls;
    expect(call?.idempotencyKey).toBe(intentId);
    expect(result.intent.durableLedgerEventId).toBe(call?.eventId);
  });

  it("executing short-circuit: no client call, no write", async () => {
    const countingRepo = new CountingUpdateRepository();
    const intentId = await seedProposed(countingRepo, llm, seq);
    const firstUseCase = new AutoApproveIntent(
      countingRepo,
      agentCore,
      TOKEN,
      {},
      CLOCK,
    );
    const first = await firstUseCase.execute({
      intentId,
      customerId: CUSTOMER_ID,
    });
    expect(first.intent.status).toBe("executing");
    expect(agentCore.calls).toHaveLength(1);

    countingRepo.updateCalls = 0;
    const second = await firstUseCase.execute({
      intentId,
      customerId: CUSTOMER_ID,
    });
    expect(second.intent.status).toBe("executing");
    expect(second.verdict).toBeNull();
    // No new client call, no write.
    expect(agentCore.calls).toHaveLength(1);
    expect(countingRepo.updateCalls).toBe(0);

    const get = new GetIntent(countingRepo);
    const reread = await get.execute(intentId);
    expect(reread.durableLedgerEventId).toBe(first.intent.durableLedgerEventId);
  });

  describe("wrong status — InvalidIntentStateError, zero client calls, storage untouched", () => {
    const otherStatuses: readonly IntentStatus[] = [
      "received",
      "needs_clarification",
      "needs_approval",
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
                merchantId: "vendor",
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

      await expect(
        useCase.execute({ intentId: id, customerId: CUSTOMER_ID }),
      ).rejects.toBeInstanceOf(InvalidIntentStateError);
      expect(agentCore.calls).toHaveLength(0);

      const stored = await repo.findById(id);
      expect(stored?.intent.status).toBe(status);
    });
  });

  it("fresh re-evaluation flips to needs_approval when the auto-approve threshold has since been lowered: exactly one write, zero agent-core calls", async () => {
    const intentId = await seedProposed(repo, llm, seq);
    const strictUseCase = new AutoApproveIntent(
      repo,
      agentCore,
      TOKEN,
      { maxAutoApproveAmount: 1 },
      CLOCK,
    );

    const result = await strictUseCase.execute({
      intentId,
      customerId: CUSTOMER_ID,
    });
    expect(result.intent.status).toBe("needs_approval");
    expect(result.verdict?.decision).toBe("needs_approval");
    expect(agentCore.calls).toHaveLength(0);

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("needs_approval");
  });

  it("fresh re-evaluation flips to reject when the hard limit has since been lowered below the proposal: zero agent-core calls", async () => {
    const intentId = await seedProposed(repo, llm, seq);
    const strictUseCase = new AutoApproveIntent(
      repo,
      agentCore,
      TOKEN,
      { maxAutoApproveAmount: 1, maxHardLimitAmount: 1 },
      CLOCK,
    );

    const result = await strictUseCase.execute({
      intentId,
      customerId: CUSTOMER_ID,
    });
    expect(result.intent.status).toBe("rejected");
    expect(result.verdict?.decision).toBe("reject");
    expect(agentCore.calls).toHaveLength(0);
  });

  it("fresh re-evaluation rejects a stored proposal whose merchant is absent from the intent text: zero agent-core calls", async () => {
    const id = "intent_swapped_merchant";
    await seedFixedIntent(repo, {
      id,
      status: "proposed",
      text: ALLOW_TEXT,
      proposal: paymentProposal({
        amount: 5_000,
        currency: "USD",
        merchantId: "attacker-wallet-1",
        reasoning: "Selected the amount from the intent text.",
      }),
    });

    const result = await useCase.execute({
      intentId: id,
      customerId: CUSTOMER_ID,
    });
    expect(result.intent.status).toBe("rejected");
    expect(result.verdict).toMatchObject({
      decision: "reject",
      reason: "merchant_not_grounded",
    });
    expect(agentCore.calls).toHaveLength(0);
  });

  it("agent-core client throws: the error propagates, intent stays proposed, no write attempted", async () => {
    const countingRepo = new CountingUpdateRepository();
    const intentId = await seedProposed(countingRepo, llm, seq);
    agentCore.startError = new AgentCoreUnavailableError(
      "durable-ledger unreachable",
      {
        operation: "start_payment_workflow",
        status: 503,
        ledgerCode: undefined,
      },
    );
    const failingUseCase = new AutoApproveIntent(
      countingRepo,
      agentCore,
      TOKEN,
      {},
      CLOCK,
    );

    await expect(
      failingUseCase.execute({ intentId, customerId: CUSTOMER_ID }),
    ).rejects.toBeInstanceOf(AgentCoreUnavailableError);
    expect(countingRepo.updateCalls).toBe(0);

    const stored = await countingRepo.findById(intentId);
    expect(stored?.intent.status).toBe("proposed");
  });

  it("version conflict on the confirming write: throws ExecutionRaceLostError carrying this call's own eventId", async () => {
    const racyRepo = new ConflictOnUpdateRepository();
    const intentId = await seedProposed(racyRepo, llm, seq);
    racyRepo.conflictOnNextUpdate = true;
    const racyUseCase = new AutoApproveIntent(
      racyRepo,
      agentCore,
      TOKEN,
      {},
      CLOCK,
    );

    await expect(
      racyUseCase.execute({ intentId, customerId: CUSTOMER_ID }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ExecutionRaceLostError);
      const raceErr = err as ExecutionRaceLostError;
      expect(raceErr.intentId).toBe(intentId);
      expect(raceErr.durableLedgerEventId).toBe(agentCore.calls[0]?.eventId);
      expect(raceErr.cause).toBeInstanceOf(IntentVersionConflictError);
      return true;
    });
    expect(agentCore.calls).toHaveLength(1);
  });

  it("paymentProposal === null on the stored intent throws InvalidProposalError; zero client calls", async () => {
    const id = "intent_bad_proposal";
    await seedFixedIntent(repo, {
      id,
      status: "proposed",
      proposal: clarifyProposal("Which invoice?"),
    });

    await expect(
      useCase.execute({ intentId: id, customerId: CUSTOMER_ID }),
    ).rejects.toBeInstanceOf(InvalidProposalError);
    expect(agentCore.calls).toHaveLength(0);
  });

  it("unknown intent id throws IntentNotFoundError; zero client calls", async () => {
    await expect(
      useCase.execute({
        intentId: "does_not_exist",
        customerId: CUSTOMER_ID,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof IntentNotFoundError && err.id === "does_not_exist",
    );
    expect(agentCore.calls).toHaveLength(0);
  });

  it("customerId mismatch on a genuinely existing intent throws IntentNotFoundError (same shape as a real miss), zero client calls", async () => {
    const intentId = await seedProposed(repo, llm, seq, CUSTOMER_ID);

    await expect(
      useCase.execute({ intentId, customerId: "cust_someone_else" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof IntentNotFoundError && err.id === intentId,
    );
    expect(agentCore.calls).toHaveLength(0);

    const stored = await repo.findById(intentId);
    expect(stored?.intent.status).toBe("proposed");
  });

  describe("validation failures — no repository write, no client call", () => {
    it("rejects a blank intentId", async () => {
      await expect(
        useCase.execute({ intentId: "", customerId: CUSTOMER_ID }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(agentCore.calls).toHaveLength(0);
    });

    it("rejects a missing intentId", async () => {
      await expect(
        useCase.execute({
          customerId: CUSTOMER_ID,
        } as unknown as AutoApproveIntentCommand),
      ).rejects.toBeInstanceOf(ZodError);
      expect(agentCore.calls).toHaveLength(0);
    });

    it("rejects a missing customerId", async () => {
      await expect(
        useCase.execute({
          intentId: "intent_1",
        } as unknown as AutoApproveIntentCommand),
      ).rejects.toBeInstanceOf(ZodError);
      expect(agentCore.calls).toHaveLength(0);
    });

    it("rejects a malformed customerId", async () => {
      await expect(
        useCase.execute({
          intentId: "intent_1",
          customerId: "not a valid customer id!!",
        }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(agentCore.calls).toHaveLength(0);
    });
  });

  it("blank paymentMethodToken throws immediately at construction, before execute() is ever called", () => {
    expect(
      () => new AutoApproveIntent(repo, agentCore, "   ", {}, CLOCK),
    ).toThrow(Error);
    expect(
      () => new AutoApproveIntent(repo, agentCore, "   ", {}, CLOCK),
    ).not.toThrow(InvalidIntentStateError);
  });

  it("a bad policy config throws at construction time, not on the first execute()", () => {
    expect(
      () =>
        new AutoApproveIntent(
          repo,
          agentCore,
          TOKEN,
          { maxAutoApproveAmount: -1 },
          CLOCK,
        ),
    ).toThrow(/maxAutoApproveAmount/);
  });
});
