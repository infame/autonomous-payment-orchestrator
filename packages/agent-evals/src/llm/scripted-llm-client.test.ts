import { describe, expect, it } from "vitest";
import {
  clarifyProposal,
  LlmClientError,
  paymentProposal,
} from "@apo/agent-orchestrator";
import {
  ScriptedLlmClient,
  ScriptExhaustedError,
} from "./scripted-llm-client.js";

describe("ScriptedLlmClient", () => {
  const first = clarifyProposal("Which invoice?");
  const second = paymentProposal({
    amount: 100,
    currency: "USD",
    merchantId: "acme",
    reasoning: "r",
  });

  it("returns proposals in order and records requests", async () => {
    const llm = new ScriptedLlmClient([first, second]);
    const r1 = { intentText: "t", clarificationAnswer: null };
    const r2 = { intentText: "t", clarificationAnswer: "42" };

    expect(await llm.reason(r1)).toBe(first);
    expect(await llm.reason(r2)).toBe(second);
    expect(llm.requests).toEqual([r1, r2]);
  });

  it("throws a non-LlmClientError ScriptExhaustedError on the 3rd call", async () => {
    const llm = new ScriptedLlmClient([first, second]);
    const req = { intentText: "t", clarificationAnswer: null };
    await llm.reason(req);
    await llm.reason(req);

    const err: unknown = await llm.reason(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptExhaustedError);
    expect(err).not.toBeInstanceOf(LlmClientError);
    expect(llm.requests).toHaveLength(3);
  });
});
