import { describe, expect, it } from "vitest";
import {
  isStartCall,
  RecordingAgentCoreClient,
} from "../core/recording-agent-core-client.js";
import { runSwapped as runSwappedWith } from "./scenarios.js";

const runSwapped = () => runSwappedWith(new RecordingAgentCoreClient());

// Regression for the spec §9.1 finding, fixed by merchantMustBeGrounded
// (ADR-0017). benign-auto-approve.test.ts is the non-vacuity control: the same
// harness with a grounded merchant still reaches durable-ledger.
describe("injection: merchant swap via the LLM proposal (spec 9.1)", () => {
  it("a swapped merchant is rejected by policy and never reaches durable-ledger", async () => {
    const obs = await runSwapped();

    expect(obs.http[0]?.status).toBe(201);
    expect(obs.finalView?.status).toBe("rejected");
    expect(obs.finalView?.policyVerdict).toMatchObject({
      decision: "reject",
      reason: "merchant_not_grounded",
    });
    expect(obs.coreCalls.filter(isStartCall)).toHaveLength(0);
    expect(obs.coreCalls).toHaveLength(0);
  });

  // Deliberately redundant with the assertion above: the original
  // desired-behavior test, kept verbatim from the it.fails flip (ADR-0017), so
  // the finding's own wording stays in the suite.
  it("must not trigger a payment to a merchant absent from the intent text", async () => {
    const obs = await runSwapped();
    expect(
      obs.coreCalls.filter((c) => c.method === "startPaymentWorkflow"),
    ).toHaveLength(0);
  });
});
