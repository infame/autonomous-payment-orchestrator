import { describe, expect, it, beforeEach } from "vitest";
import { GetIntent } from "./get-intent.js";
import { SubmitIntent } from "./submit-intent.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { MockLlmClient } from "../adapters/llm/mock-llm-client.js";
import { IntentNotFoundError } from "../domain/errors.js";

const CLOCK = () => new Date("2026-07-01T00:00:00Z");

describe("GetIntent", () => {
  let repo: InMemoryIntentRepository;
  let submit: SubmitIntent;
  let get: GetIntent;
  let seq: number;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    seq = 0;
    submit = new SubmitIntent(
      repo,
      new MockLlmClient(),
      {},
      CLOCK,
      () => `intent_${++seq}`,
    );
    get = new GetIntent(repo);
  });

  it("returns a view matching what SubmitIntent returned", async () => {
    const submitted = await submit.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    const view = await get.execute(submitted.intent.id);

    expect(view).toEqual(submitted.intent);
  });

  it("throws IntentNotFoundError with the requested id for an unknown id", async () => {
    await expect(get.execute("missing_id")).rejects.toBeInstanceOf(
      IntentNotFoundError,
    );
    try {
      await get.execute("missing_id");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IntentNotFoundError);
      expect((error as IntentNotFoundError).id).toBe("missing_id");
    }
  });

  it("surfaces a persisted verdict for a needs_approval intent", async () => {
    const submitted = await submit.execute({
      text: "Pay the vendor $600.00 for the invoice.",
      customerId: "cust_1",
    });

    const view = await get.execute(submitted.intent.id);
    expect(view.status).toBe("needs_approval");
    expect(view.policyVerdict).not.toBeNull();
    expect(view.policyVerdict).toMatchObject({
      decision: "needs_approval",
      reason: "above_auto_approve_threshold",
    });
  });

  it("does not alias nested proposal objects across calls", async () => {
    const submitted = await submit.execute({
      text: "Pay the vendor $50.00 for the invoice.",
      customerId: "cust_1",
    });

    const first = await get.execute(submitted.intent.id);
    if (first.proposal !== null && first.proposal.kind === "propose_payment") {
      (first.proposal as unknown as { amount: number }).amount = 999_999;
    }

    const second = await get.execute(submitted.intent.id);
    expect(second.proposal).toMatchObject({
      kind: "propose_payment",
      amount: 5_000,
    });
  });
});
