import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import {
  AnswerClarification,
  AnswerClarificationCommand,
} from "./answer-clarification.js";
import { SubmitIntent } from "./submit-intent.js";
import { GetIntent } from "./get-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import { LlmUnavailableError } from "../ports/llm-client.js";
import type { LlmClient, LlmReasoningRequest } from "../ports/llm-client.js";
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
import {
  clarifyProposal,
  type AgentProposal,
  type DeclineProposal,
} from "../domain/agent-proposal.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

/** A repository whose `create()` throws once seeding is done — used to prove `AnswerClarification` never calls it. */
class NoCreateAfterSeedRepository extends InMemoryIntentRepository {
  seedingComplete = false;
  updateCalls = 0;

  override async create(intent: Intent): Promise<StoredIntent> {
    if (this.seedingComplete) {
      throw new Error("create() must not be called by AnswerClarification");
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

/** Counts calls to `reason()` — used to pin "no retry" behaviour. */
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

/**
 * A minimal `LlmClient` test double that returns `clarify` on every call.
 * `MockLlmClient` cannot produce a genuine second `clarify` — its own
 * `#resolveClarifyFallthrough` always resolves a second-round `clarify`
 * directive to a concrete payment/decline outcome (see its header) — so
 * this stub exists purely to exercise `AnswerClarification`'s own handling
 * of a second `clarify` from the LLM.
 */
class ClarifyTwiceLlmClient implements LlmClient {
  readonly name = "stub-clarify-twice";
  calls = 0;
  async reason(_input: LlmReasoningRequest): Promise<AgentProposal> {
    this.calls += 1;
    return clarifyProposal(
      this.calls === 1
        ? "Which invoice are you referring to?"
        : "Still ambiguous — can you confirm the exact amount, like $999.00?",
    );
  }
}

/** Submits via `SubmitIntent` with a `sim.clarify`-style directive to reach `needs_clarification`. */
async function seedNeedsClarification(
  repo: IntentRepository,
  llm: LlmClient,
  seq: { n: number },
  text: string,
  customerId = "cust_1",
): Promise<string> {
  const submit = new SubmitIntent(
    repo,
    llm,
    {},
    CLOCK,
    () => `intent_${++seq.n}`,
  );
  const result = await submit.execute({ text, customerId });
  expect(result.intent.status).toBe("needs_clarification");
  return result.intent.id;
}

describe("AnswerClarification", () => {
  let repo: InMemoryIntentRepository;
  let llm: MockLlmClient;
  let seq: { n: number };
  let useCase: AnswerClarification;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    llm = new MockLlmClient();
    seq = { n: 0 };
    useCase = new AnswerClarification(repo, llm, {}, CLOCK);
  });

  it("happy path: original text has no digits at all, amount comes entirely from the answer", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    const result = await useCase.execute({
      intentId,
      answer: "The invoice amount is $50.00.",
    });

    expect(result.intent.status).toBe("proposed");
    expect(result.intent.proposal).toMatchObject({
      kind: "propose_payment",
      amount: 5_000,
    });
    expect(result.verdict?.decision).toBe("allow");
    expect(result.intent.policyVerdict).toBeNull();
  });

  it("answer's amount pushes it to needs_approval (above auto-approve, below hard limit)", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    const result = await useCase.execute({
      intentId,
      answer: "Pay the vendor $600.00 for the invoice.",
    });

    expect(result.intent.status).toBe("needs_approval");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "needs_approval",
      reason: "above_auto_approve_threshold",
    });
  });

  it("answer's amount above the hard limit is rejected", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    const result = await useCase.execute({
      intentId,
      answer: "Pay the vendor $6000.00 for the invoice.",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "hard_limit_exceeded",
    });
  });

  it("an ungrounded amount from the answer is rejected — proves the answer widening the grounded set doesn't disable this guardrail", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    const result = await useCase.execute({
      intentId,
      answer: "sim.amount.ungrounded",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "amount_not_grounded",
    });
  });

  it("agent declines on the second round: rejected, proposal.kind decline", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    const result = await useCase.execute({
      intentId,
      answer: "sim.decline",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.proposal?.kind).toBe("decline");
  });

  it("a genuine second clarify from the LLM becomes a synthetic rejection, never echoing the model's actual question", async () => {
    const stub = new ClarifyTwiceLlmClient();
    const submit = new SubmitIntent(
      repo,
      stub,
      {},
      CLOCK,
      () => `intent_${++seq.n}`,
    );
    const submitted = await submit.execute({
      text: "Please handle my payment.",
      customerId: "cust_1",
    });
    expect(submitted.intent.status).toBe("needs_clarification");

    const stubUseCase = new AnswerClarification(repo, stub, {}, CLOCK);
    const result = await stubUseCase.execute({
      intentId: submitted.intent.id,
      answer: "I'm not sure, can you just figure it out?",
    });

    expect(result.intent.status).toBe("rejected");
    expect(result.intent.proposal?.kind).toBe("decline");
    const decline = result.intent.proposal as DeclineProposal;
    expect(decline.reason).not.toContain("$999.00");
    expect(decline.reason).not.toContain("Still ambiguous");
    expect(decline.reason).not.toContain(
      "Still ambiguous — can you confirm the exact amount, like $999.00?",
    );
  });

  it("answering an intent that's already not needs_clarification throws InvalidIntentStateError, storage unchanged", async () => {
    const submit = new SubmitIntent(
      repo,
      llm,
      {},
      CLOCK,
      () => `intent_${++seq.n}`,
    );
    const submitted = await submit.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });
    expect(submitted.intent.status).toBe("proposed");

    await expect(
      useCase.execute({
        intentId: submitted.intent.id,
        answer: "Some answer",
      }),
    ).rejects.toBeInstanceOf(InvalidIntentStateError);

    const get = new GetIntent(repo);
    const reread = await get.execute(submitted.intent.id);
    expect(reread.status).toBe("proposed");
    expect(reread.clarificationAnswer).toBeNull();
  });

  it("answering an unknown intent id throws IntentNotFoundError with a matching id", async () => {
    await expect(
      useCase.execute({ intentId: "does_not_exist", answer: "Some answer" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof IntentNotFoundError && err.id === "does_not_exist",
    );
  });

  it("round-trip through storage: clarificationAnswer equals the submitted answer verbatim", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    await useCase.execute({
      intentId,
      answer: "The invoice amount is $50.00.",
    });

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.clarificationAnswer).toBe("The invoice amount is $50.00.");
  });

  it("LLM unavailable on the second call: rejects with LlmUnavailableError, storage still needs_clarification with a null clarificationAnswer", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    await expect(
      useCase.execute({ intentId, answer: "sim.unavailable" }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);

    const get = new GetIntent(repo);
    const reread = await get.execute(intentId);
    expect(reread.status).toBe("needs_clarification");
    expect(reread.clarificationAnswer).toBeNull();
  });

  it("version conflict: the losing concurrent call rejects with IntentVersionConflictError and does not retry the LLM call", async () => {
    const intentId = await seedNeedsClarification(
      repo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );

    const countingLlm = new CountingLlmClient(llm);
    const useCaseA = new AnswerClarification(repo, countingLlm, {}, CLOCK);
    const useCaseB = new AnswerClarification(repo, countingLlm, {}, CLOCK);

    const [resultA, resultB] = await Promise.allSettled([
      useCaseA.execute({ intentId, answer: "Pay the vendor $50.00." }),
      useCaseB.execute({ intentId, answer: "Pay the vendor $60.00." }),
    ]);

    const outcomes = [resultA.status, resultB.status];
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);

    const rejected = [resultA, resultB].find((r) => r.status === "rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(IntentVersionConflictError);
    }

    // Exactly one reason() call per execute() attempt — no retry after the
    // losing update() throws.
    expect(countingLlm.calls).toBe(2);
  });

  it("exactly-one-write guard: never calls create(), and calls update() exactly once per outcome (allow/needs_approval/reject)", async () => {
    const guardedRepo = new NoCreateAfterSeedRepository();
    const allowId = await seedNeedsClarification(
      guardedRepo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );
    const approvalId = await seedNeedsClarification(
      guardedRepo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );
    const rejectId = await seedNeedsClarification(
      guardedRepo,
      llm,
      seq,
      "Please handle my payment for the vendor invoice. sim.clarify",
    );
    guardedRepo.seedingComplete = true;

    const guardedUseCase = new AnswerClarification(guardedRepo, llm, {}, CLOCK);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({
        intentId: allowId,
        answer: "Pay the vendor $50.00 for the invoice.",
      }),
    ).resolves.toMatchObject({ intent: { status: "proposed" } });
    expect(guardedRepo.updateCalls).toBe(1);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({
        intentId: approvalId,
        answer: "Pay the vendor $600.00 for the invoice.",
      }),
    ).resolves.toMatchObject({ intent: { status: "needs_approval" } });
    expect(guardedRepo.updateCalls).toBe(1);

    guardedRepo.updateCalls = 0;
    await expect(
      guardedUseCase.execute({
        intentId: rejectId,
        answer: "Pay the vendor $6000.00 for the invoice.",
      }),
    ).resolves.toMatchObject({ intent: { status: "rejected" } });
    expect(guardedRepo.updateCalls).toBe(1);
  });

  describe("validation failures — no repository write occurs", () => {
    it("rejects a blank answer", async () => {
      const intentId = await seedNeedsClarification(
        repo,
        llm,
        seq,
        "Please handle my payment for the vendor invoice. sim.clarify",
      );
      await expect(
        useCase.execute({ intentId, answer: "   " }),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it("rejects an over-length answer", async () => {
      const intentId = await seedNeedsClarification(
        repo,
        llm,
        seq,
        "Please handle my payment for the vendor invoice. sim.clarify",
      );
      await expect(
        useCase.execute({ intentId, answer: "x".repeat(2_001) }),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it("rejects an empty intentId", async () => {
      await expect(
        useCase.execute({ intentId: "", answer: "Some answer" }),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it("validates a well-formed AnswerClarificationCommand via the exported schema", () => {
      expect(() =>
        AnswerClarificationCommand.parse({
          intentId: "intent_1",
          answer: "Pay $1.00",
        }),
      ).not.toThrow();
    });
  });
});
