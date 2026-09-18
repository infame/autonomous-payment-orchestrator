import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  SyncIntentExecution,
  SyncIntentExecutionCommand,
} from "./sync-intent-execution.js";
import { SubmitIntent } from "./submit-intent.js";
import { ApproveIntent } from "./approve-intent.js";
import { GetIntent } from "./get-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import { FakeAgentCoreClient } from "../adapters/memory/fake-agent-core-client.js";
import {
  IntentVersionConflictError,
  type IntentRepository,
  type StoredIntent,
} from "../ports/intent-repository.js";
import {
  AgentCoreBadRequestError,
  AgentCoreMalformedResponseError,
  AgentCoreNetworkError,
  AgentCoreRequestCanceledError,
  AgentCoreRunNotFoundError,
  AgentCoreTimeoutError,
  AgentCoreUnavailableError,
  AgentCoreUnexpectedResponseError,
  type AgentCoreClientError,
  type RequestOptions,
} from "../ports/agent-core-client.js";
import { IntentNotFoundError } from "../domain/errors.js";
import { Intent } from "../domain/intent.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");
const TOKEN = "tok_test_1234";
const ERROR_CTX = {
  operation: "get_run_status" as const,
  status: undefined,
  ledgerCode: undefined,
};

/**
 * A repository whose `create()` throws once seeding is done, and which
 * counts `update()` calls — mirrors `reject-intent.test.ts`'s
 * `NoCreateAfterSeedRepository`. Used to prove `SyncIntentExecution` never
 * calls `create()`, and calls `update()` exactly once on a transitioning
 * path and zero times on every non-transitioning path.
 */
class NoCreateAfterSeedRepository extends InMemoryIntentRepository {
  seedingComplete = false;
  updateCalls = 0;

  override async create(intent: Intent): Promise<StoredIntent> {
    if (this.seedingComplete) {
      throw new Error("create() must not be called by SyncIntentExecution");
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
 * (in-memory) `update()`. Mirrors `reject-intent.test.ts`'s
 * `RaceOnUpdateIntentRepository`: deterministic version-conflict
 * construction, no `Promise.allSettled` flakiness.
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

/** Wraps `FakeAgentCoreClient` to count `getRunStatus` calls — used to prove non-executing/non-syncable paths never touch the client at all. */
class CountingAgentCoreClient extends FakeAgentCoreClient {
  getRunStatusCallCount = 0;

  override async getRunStatus(eventId: string, opts?: RequestOptions) {
    this.getRunStatusCallCount += 1;
    return super.getRunStatus(eventId, opts);
  }
}

/** Submits an amount that lands above the auto-approve threshold ($500) but below the hard limit ($5000) — reaches `needs_approval`. */
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

/** Submits an amount at/below the auto-approve threshold — reaches `proposed` (no auto-approve wiring exists yet in this package). */
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
  const result = await submit.execute({
    text: "Pay the vendor $50.00 for the invoice.",
    customerId,
  });
  expect(result.intent.status).toBe("proposed");
  return result.intent.id;
}

/** Submits an amount above the hard limit — reaches `rejected` via a policy hard-reject. */
async function seedRejected(
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
    text: "Pay the vendor $6000.00 for the invoice.",
    customerId,
  });
  expect(result.intent.status).toBe("rejected");
  return result.intent.id;
}

/** Reaches `executing` for real, via `SubmitIntent` + `ApproveIntent` against a `FakeAgentCoreClient`. */
async function seedExecuting(
  repo: IntentRepository,
  llm: MockLlmClient,
  agentCore: FakeAgentCoreClient,
  seq: { n: number },
  customerId = "cust_1",
): Promise<{ intentId: string; eventId: string }> {
  const intentId = await seedNeedsApproval(repo, llm, seq, customerId);
  const approve = new ApproveIntent(repo, agentCore, TOKEN, CLOCK);
  const approved = await approve.execute({ intentId });
  expect(approved.status).toBe("executing");
  const eventId = approved.durableLedgerEventId;
  if (eventId === null) {
    throw new Error("expected seedExecuting to produce a durableLedgerEventId");
  }
  return { intentId: approved.id, eventId };
}

describe("SyncIntentExecution", () => {
  let repo: InMemoryIntentRepository;
  let llm: MockLlmClient;
  let agentCore: CountingAgentCoreClient;
  let seq: { n: number };
  let useCase: SyncIntentExecution;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    llm = new MockLlmClient();
    agentCore = new CountingAgentCoreClient();
    seq = { n: 0 };
    useCase = new SyncIntentExecution(repo, agentCore, CLOCK);
  });

  describe("non-executing intent: returned unchanged, no client call, no write", () => {
    it("needs_approval", async () => {
      const intentId = await seedNeedsApproval(repo, llm, seq);
      const result = await useCase.execute({ intentId });
      expect(result.status).toBe("needs_approval");
      expect(agentCore.getRunStatusCallCount).toBe(0);
    });

    it("proposed", async () => {
      const intentId = await seedProposed(repo, llm, seq);
      const result = await useCase.execute({ intentId });
      expect(result.status).toBe("proposed");
      expect(agentCore.getRunStatusCallCount).toBe(0);
    });

    it("rejected", async () => {
      const intentId = await seedRejected(repo, llm, seq);
      const result = await useCase.execute({ intentId });
      expect(result.status).toBe("rejected");
      expect(agentCore.getRunStatusCallCount).toBe(0);
    });
  });

  it("executing + snapshot completed -> intent transitions to completed", async () => {
    const { intentId, eventId } = await seedExecuting(
      repo,
      llm,
      agentCore,
      seq,
    );
    agentCore.settleRun(eventId, { status: "completed" });

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("completed");
    expect(agentCore.getRunStatusCallCount).toBe(1);

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("completed");
  });

  it("executing + snapshot failed -> intent transitions to failed", async () => {
    const { intentId, eventId } = await seedExecuting(
      repo,
      llm,
      agentCore,
      seq,
    );
    agentCore.settleRun(eventId, { status: "failed" });

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("failed");

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("failed");
  });

  it("executing + snapshot cancelled -> intent transitions to failed", async () => {
    const { intentId, eventId } = await seedExecuting(
      repo,
      llm,
      agentCore,
      seq,
    );
    agentCore.settleRun(eventId, { status: "cancelled" });

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("failed");
  });

  it("needsReview + failed (the only combination durable-ledger's real producer can emit) -> needs_review, exactly one write", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const { intentId, eventId } = await seedExecuting(
      guardedRepo,
      llm,
      agentCore,
      seq,
    );
    // Mirrors inngest-workflow-runs.ts's actual production rule:
    // needsReview is only ever true together with status === "failed".
    agentCore.settleRun(eventId, { status: "failed", needsReview: true });
    guardedRepo.seedingComplete = true;
    guardedRepo.updateCalls = 0;

    const guardedUseCase = new SyncIntentExecution(
      guardedRepo,
      agentCore,
      CLOCK,
    );
    const result = await guardedUseCase.execute({ intentId });
    expect(result.status).toBe("needs_review");
    expect(guardedRepo.updateCalls).toBe(1);

    const get = new GetIntent(guardedRepo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("needs_review");
  });

  it("hypothetical: needsReview would still take priority over status even paired with a non-failed status — a shape durable-ledger's real producer cannot emit, but if this port's invariant were ever violated, failing safe toward the more conservative needs_review (rather than silently downgrading to completed) is the correct choice, not a bug", async () => {
    const { intentId, eventId } = await seedExecuting(
      repo,
      llm,
      agentCore,
      seq,
    );
    // Deliberately constructs an impossible-in-practice snapshot (see class
    // header, "needsReview is checked before status") to pin the ordering
    // itself, independent of whether the real producer could ever emit it.
    agentCore.settleRun(eventId, { status: "completed", needsReview: true });

    const result = await useCase.execute({ intentId });
    expect(result.status).toBe("needs_review");

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("needs_review");
  });

  describe("executing + non-terminal snapshot: stays executing, no write", () => {
    it("queued (default snapshot right after startPaymentWorkflow)", async () => {
      const guardedRepo = new NoCreateAfterSeedRepository();
      const { intentId } = await seedExecuting(
        guardedRepo,
        llm,
        agentCore,
        seq,
      );
      guardedRepo.seedingComplete = true;
      guardedRepo.updateCalls = 0;

      const guardedUseCase = new SyncIntentExecution(
        guardedRepo,
        agentCore,
        CLOCK,
      );
      const result = await guardedUseCase.execute({ intentId });
      expect(result.status).toBe("executing");
      expect(guardedRepo.updateCalls).toBe(0);
    });

    it("running", async () => {
      const guardedRepo = new NoCreateAfterSeedRepository();
      const { intentId, eventId } = await seedExecuting(
        guardedRepo,
        llm,
        agentCore,
        seq,
      );
      agentCore.settleRun(eventId, { status: "running" });
      guardedRepo.seedingComplete = true;
      guardedRepo.updateCalls = 0;

      const guardedUseCase = new SyncIntentExecution(
        guardedRepo,
        agentCore,
        CLOCK,
      );
      const result = await guardedUseCase.execute({ intentId });
      expect(result.status).toBe("executing");
      expect(guardedRepo.updateCalls).toBe(0);
    });
  });

  it("durableLedgerEventId === null on an executing intent (defensive/unreachable in practice — see class header) -> returned unchanged, no client call, no write", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const now = CLOCK();
    const intent = Intent.fromState({
      id: "intent_defensive_null_event_id",
      customerId: "cust_1",
      text: "Pay the vendor $600.00 for the invoice.",
      status: "executing",
      proposal: null,
      policyVerdict: null,
      durableLedgerEventId: null,
      clarificationAnswer: null,
      createdAt: now,
      updatedAt: now,
    });
    await guardedRepo.create(intent);
    guardedRepo.seedingComplete = true;
    guardedRepo.updateCalls = 0;

    const guardedUseCase = new SyncIntentExecution(
      guardedRepo,
      agentCore,
      CLOCK,
    );
    const result = await guardedUseCase.execute({ intentId: intent.id });
    expect(result.status).toBe("executing");
    expect(result.durableLedgerEventId).toBeNull();
    expect(guardedRepo.updateCalls).toBe(0);
    expect(agentCore.getRunStatusCallCount).toBe(0);
  });

  describe("AgentCoreClientError is swallowed: returns stored view unchanged, no write", () => {
    const cases: [string, () => AgentCoreClientError][] = [
      [
        "AgentCoreNetworkError",
        () => new AgentCoreNetworkError("boom", ERROR_CTX),
      ],
      [
        "AgentCoreTimeoutError",
        () => new AgentCoreTimeoutError("boom", ERROR_CTX, 5000),
      ],
      [
        "AgentCoreRequestCanceledError",
        () => new AgentCoreRequestCanceledError("boom", ERROR_CTX),
      ],
      [
        "AgentCoreBadRequestError",
        () => new AgentCoreBadRequestError("boom", ERROR_CTX),
      ],
      [
        "AgentCoreRunNotFoundError",
        () => new AgentCoreRunNotFoundError("boom", ERROR_CTX),
      ],
      [
        "AgentCoreUnavailableError",
        () => new AgentCoreUnavailableError("boom", ERROR_CTX),
      ],
      [
        "AgentCoreUnexpectedResponseError",
        () => new AgentCoreUnexpectedResponseError("boom", ERROR_CTX),
      ],
      [
        "AgentCoreMalformedResponseError",
        () => new AgentCoreMalformedResponseError("boom", ERROR_CTX),
      ],
    ];

    it.each(cases)("%s", async (_name, makeError) => {
      const guardedRepo = new NoCreateAfterSeedRepository();
      const localAgentCore = new FakeAgentCoreClient();
      const { intentId } = await seedExecuting(
        guardedRepo,
        llm,
        localAgentCore,
        seq,
      );
      guardedRepo.seedingComplete = true;
      guardedRepo.updateCalls = 0;
      localAgentCore.getRunStatusError = makeError();

      const guardedUseCase = new SyncIntentExecution(
        guardedRepo,
        localAgentCore,
        CLOCK,
      );
      const result = await guardedUseCase.execute({ intentId });
      expect(result.status).toBe("executing");
      expect(guardedRepo.updateCalls).toBe(0);
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

  it("version conflict on the confirm write propagates as IntentVersionConflictError, not wrapped", async () => {
    const racyRepo = new RaceOnUpdateIntentRepository();
    const { intentId, eventId } = await seedExecuting(
      racyRepo,
      llm,
      agentCore,
      seq,
    );
    agentCore.settleRun(eventId, { status: "completed" });

    racyRepo.race = async () => {
      const fresh = await racyRepo.findById(intentId);
      if (!fresh) throw new Error("expected intent to exist");
      fresh.intent.fail(CLOCK());
      await racyRepo.update(fresh.intent, fresh.version);
    };

    const outer = new SyncIntentExecution(racyRepo, agentCore, CLOCK);
    await expect(outer.execute({ intentId })).rejects.toBeInstanceOf(
      IntentVersionConflictError,
    );

    const stored = await racyRepo.findById(intentId);
    expect(stored?.intent.status).toBe("failed");
  });

  it("exactly-one-write guard: never calls create(), calls update() exactly once on a transitioning path, zero on every non-transitioning path", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const executingA = await seedExecuting(guardedRepo, llm, agentCore, seq);
    const executingB = await seedExecuting(guardedRepo, llm, agentCore, seq);
    const proposedId = await seedProposed(guardedRepo, llm, seq);
    guardedRepo.seedingComplete = true;

    const guardedUseCase = new SyncIntentExecution(
      guardedRepo,
      agentCore,
      CLOCK,
    );

    agentCore.settleRun(executingA.eventId, { status: "completed" });
    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: executingA.intentId }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(guardedRepo.updateCalls).toBe(1);

    // executingB stays queued -- no transition, no write.
    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: executingB.intentId }),
    ).resolves.toMatchObject({ status: "executing" });
    expect(guardedRepo.updateCalls).toBe(0);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: proposedId }),
    ).resolves.toMatchObject({ status: "proposed" });
    expect(guardedRepo.updateCalls).toBe(0);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({ intentId: "does_not_exist" }),
    ).rejects.toBeInstanceOf(IntentNotFoundError);
    expect(guardedRepo.updateCalls).toBe(0);
  });

  describe("validation failures", () => {
    it("rejects an empty intentId", async () => {
      await expect(useCase.execute({ intentId: "" })).rejects.toBeInstanceOf(
        ZodError,
      );
      expect(agentCore.getRunStatusCallCount).toBe(0);
    });

    it("rejects a missing intentId", async () => {
      await expect(
        SyncIntentExecutionCommand.parseAsync({}),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });
});
