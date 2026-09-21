import { describe, expect, it } from "vitest";
import { exactlyOnce } from "./exactly-once.js";
import {
  exchange,
  observation,
  observedIntent,
  startCall,
} from "./observation-fixture.js";

describe("I5 exactly-once", () => {
  it("catches two starts sharing an idempotency key", () => {
    const r = exactlyOnce(
      observation({
        intents: [
          observedIntent(),
          observedIntent({ id: "intent_2", submitExchangeIndex: 1 }),
        ],
        coreCalls: [
          startCall({ index: 0, idempotencyKey: "k" }),
          startCall({ index: 1, idempotencyKey: "k" }),
        ],
        http: [
          exchange({ coreCallIndexes: [0] }),
          exchange({ index: 1, intentId: "intent_2", coreCallIndexes: [1] }),
        ],
      }),
    );
    expect(r.subjects).toBe(2);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.coreCallIndex).toBe(1);
  });

  it("catches two starts attributed to one intent under different keys", () => {
    const r = exactlyOnce(
      observation({
        coreCalls: [
          startCall({ index: 0, idempotencyKey: "a" }),
          startCall({ index: 1, idempotencyKey: "b" }),
        ],
        http: [exchange({ coreCallIndexes: [0, 1] })],
      }),
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.intentId).toBe("intent_1");
  });

  it("catches a start without an idempotency key", () => {
    const r = exactlyOnce(
      observation({
        coreCalls: [startCall({ idempotencyKey: undefined })],
        http: [exchange({ coreCallIndexes: [0] })],
      }),
    );
    expect(r.violations).toHaveLength(1);
  });

  it("catches an unattributable start", () => {
    const r = exactlyOnce(observation({ coreCalls: [startCall()] }));
    expect(r.violations).toHaveLength(1);
  });

  it("passes two starts for two different intents with different keys", () => {
    const r = exactlyOnce(
      observation({
        intents: [
          observedIntent(),
          observedIntent({ id: "intent_2", submitExchangeIndex: 1 }),
        ],
        coreCalls: [
          startCall({ index: 0, idempotencyKey: "a" }),
          startCall({ index: 1, idempotencyKey: "b" }),
        ],
        http: [
          exchange({ coreCallIndexes: [0] }),
          exchange({ index: 1, intentId: "intent_2", coreCallIndexes: [1] }),
        ],
      }),
    );
    expect(r.subjects).toBe(2);
    expect(r.violations).toEqual([]);
  });
});
