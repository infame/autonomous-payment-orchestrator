import { describe, expect, it } from "vitest";
import { tenancy } from "./tenancy.js";
import {
  exchange,
  observation,
  startCall,
  view,
} from "./observation-fixture.js";

describe("I7 tenancy", () => {
  it("catches a foreign GET that succeeds and leaks an intent", () => {
    const r = tenancy(
      observation({
        http: [
          exchange(),
          exchange({
            index: 1,
            method: "GET",
            path: "/intents/intent_1",
            customerId: "other",
            status: 200,
            body: { intent: view() },
          }),
        ],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(2);
    expect(r.violations.every((v) => v.httpIndex === 1)).toBe(true);
  });

  it("catches a foreign approve that produced core calls", () => {
    const r = tenancy(
      observation({
        coreCalls: [startCall()],
        http: [
          exchange({
            path: "/intents/intent_1/approve",
            customerId: "other",
            status: 404,
            body: { error: { code: "not_found", message: "Not found" } },
            coreCallIndexes: [0],
          }),
        ],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]?.coreCallIndex).toBe(0);
  });

  it("passes a foreign GET answered 404 with no core calls", () => {
    const r = tenancy(
      observation({
        http: [
          exchange(),
          exchange({
            index: 1,
            method: "GET",
            path: "/intents/intent_1",
            customerId: "other",
            status: 404,
            body: { error: { code: "not_found", message: "Not found" } },
          }),
        ],
      }),
    );
    expect(r.subjects).toBe(1);
    expect(r.violations).toEqual([]);
  });

  it("is vacuous with no foreign exchange", () => {
    expect(tenancy(observation()).subjects).toBe(0);
  });
});
