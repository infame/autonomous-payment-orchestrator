import { describe, expect, it } from "vitest";
import { noEffectAfterReject } from "./no-effect-after-reject.js";
import {
  exchange,
  getRunStatusCall,
  observation,
  observedIntent,
  startCall,
  view,
} from "./observation-fixture.js";

const rejectedIntent = observedIntent({
  finalView: view({ status: "rejected" }),
  views: [view({ status: "rejected" })],
});

describe("I3 no effect after reject", () => {
  it("catches a start call linked to a rejected intent", () => {
    const r = noEffectAfterReject(
      observation({
        intents: [rejectedIntent],
        coreCalls: [startCall()],
        http: [exchange({ coreCallIndexes: [0] })],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.intentId).toBe("intent_1");
  });

  it("catches a getRunStatus call as the only linked call", () => {
    const r = noEffectAfterReject(
      observation({
        intents: [rejectedIntent],
        coreCalls: [getRunStatusCall()],
        http: [exchange({ coreCallIndexes: [0] })],
      }),
    );
    expect(r.violations).toHaveLength(1);
  });

  it("passes a rejected intent with an empty journal", () => {
    const r = noEffectAfterReject(observation({ intents: [rejectedIntent] }));
    expect(r.subjects).toBe(1);
    expect(r.violations).toEqual([]);
  });

  it("does not flag an executing intent with a start call", () => {
    const r = noEffectAfterReject(
      observation({
        coreCalls: [startCall()],
        http: [exchange({ coreCallIndexes: [0] })],
      }),
    );
    expect(r.subjects).toBe(0);
    expect(r.violations).toEqual([]);
  });
});
