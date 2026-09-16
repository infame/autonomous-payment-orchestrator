import { describe, expect, it, beforeEach } from "vitest";
import { ZodError } from "zod";
import { SubmitIntent, SubmitIntentCommand } from "./submit-intent.js";
import { GetIntent } from "./get-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import { LlmUnavailableError } from "../ports/llm-client.js";
import type {
  IntentRepository,
  StoredIntent,
} from "../ports/intent-repository.js";
import { Intent } from "../domain/intent.js";
import { paymentProposal } from "../domain/agent-proposal.js";
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
});
