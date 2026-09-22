/**
 * No test in this file reads a real ANTHROPIC_API_KEY or makes a real network
 * call: `inner` is always an in-repo stub `LlmClient`, never `AnthropicLlmClient`.
 */
import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  LlmClientError,
  LlmConfigurationError,
  LlmUnavailableError,
  paymentProposal,
} from "@apo/agent-orchestrator";
import type { AgentProposal, LlmClient } from "@apo/agent-orchestrator";
import {
  BudgetedLlmClient,
  LiveBudgetExhaustedError,
} from "./budgeted-llm-client.js";

const request = { intentText: "pay $10 to acme", clarificationAnswer: null };

class StubLlmClient implements LlmClient {
  readonly name = "stub";
  readonly calls: (typeof request)[] = [];

  constructor(
    private readonly responder: () => AgentProposal | Promise<AgentProposal>,
  ) {}

  async reason(input: typeof request): Promise<AgentProposal> {
    this.calls.push(input);
    return this.responder();
  }
}

const decline = () => clarifyProposal("which invoice?");

describe("BudgetedLlmClient", () => {
  it("delegates and counts up to the limit", async () => {
    const inner = new StubLlmClient(decline);
    const budgeted = new BudgetedLlmClient(inner, 2);
    expect(budgeted.name).toBe("budgeted:stub");
    expect(budgeted.calls).toBe(0);
    expect(budgeted.remaining).toBe(2);
    expect(budgeted.exhausted).toBe(false);

    await budgeted.reason(request);
    expect(budgeted.calls).toBe(1);
    expect(budgeted.remaining).toBe(1);
    expect(budgeted.exhausted).toBe(false);

    await budgeted.reason(request);
    expect(budgeted.calls).toBe(2);
    expect(budgeted.remaining).toBe(0);
    expect(budgeted.exhausted).toBe(true);
    expect(inner.calls).toHaveLength(2);
  });

  it("throws LiveBudgetExhaustedError exactly at the ceiling, never delegating that call", async () => {
    const inner = new StubLlmClient(decline);
    const budgeted = new BudgetedLlmClient(inner, 1);
    await budgeted.reason(request);
    const err: unknown = await budgeted
      .reason(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveBudgetExhaustedError);
    expect((err as LiveBudgetExhaustedError).limit).toBe(1);
    expect(inner.calls).toHaveLength(1);
    expect(budgeted.calls).toBe(1);
  });

  it("LiveBudgetExhaustedError is not an LlmClientError", () => {
    const err = new LiveBudgetExhaustedError(3);
    expect(err).not.toBeInstanceOf(LlmClientError);
    expect(err.name).toBe("LiveBudgetExhaustedError");
  });

  it("a rejecting inner call still consumes budget and is counted before delegating", async () => {
    const inner = new StubLlmClient(() => {
      throw new LlmUnavailableError("boom");
    });
    const budgeted = new BudgetedLlmClient(inner, 1);
    await expect(budgeted.reason(request)).rejects.toThrow(LlmUnavailableError);
    expect(budgeted.calls).toBe(1);
    expect(budgeted.exhausted).toBe(true);
    const err: unknown = await budgeted
      .reason(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveBudgetExhaustedError);
    expect(inner.calls).toHaveLength(1);
  });

  it("tallies failures by LlmClientError.code only, never a message, and rethrows untouched", async () => {
    let call = 0;
    const errors = [
      new LlmUnavailableError("first boom"),
      new LlmUnavailableError("second boom"),
      new LlmConfigurationError("misconfigured"),
    ];
    const inner = new StubLlmClient(() => {
      const err = errors[call];
      call += 1;
      if (err === undefined) throw new Error("test setup error");
      throw err;
    });
    const budgeted = new BudgetedLlmClient(inner, 3);
    for (let i = 0; i < 3; i += 1) {
      await expect(budgeted.reason(request)).rejects.toBe(errors[i]);
    }
    expect(budgeted.failuresByCode).toEqual({
      llm_unavailable: 2,
      llm_configuration_error: 1,
    });
    expect(JSON.stringify(budgeted.failuresByCode)).not.toContain("boom");
  });

  it("tallies a non-LlmClientError rejection under 'other'", async () => {
    const inner = new StubLlmClient(() => {
      throw new TypeError("not an LlmClientError");
    });
    const budgeted = new BudgetedLlmClient(inner, 1);
    await expect(budgeted.reason(request)).rejects.toThrow(TypeError);
    expect(budgeted.failuresByCode).toEqual({ other: 1 });
  });

  it("a successful call after a failure does not touch failuresByCode", async () => {
    let fail = true;
    const inner = new StubLlmClient(() => {
      if (fail) {
        fail = false;
        throw new LlmUnavailableError("first call fails");
      }
      return paymentProposal({
        amount: 1000,
        currency: "USD",
        merchantId: "acme",
        reasoning: "r",
      });
    });
    const budgeted = new BudgetedLlmClient(inner, 2);
    await expect(budgeted.reason(request)).rejects.toThrow(LlmUnavailableError);
    const proposal = await budgeted.reason(request);
    expect(proposal.kind).toBe("propose_payment");
    expect(budgeted.failuresByCode).toEqual({ llm_unavailable: 1 });
  });
});
