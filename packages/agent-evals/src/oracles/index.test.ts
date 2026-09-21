import { describe, expect, it } from "vitest";
import { checkInvariants, ORACLES, violationsOf } from "./index.js";
import { observation } from "./observation-fixture.js";

describe("ORACLES", () => {
  it("has exactly eight oracles with unique ids in I1..I8 order", () => {
    expect(ORACLES).toHaveLength(8);
    const ids = checkInvariants(observation()).map((r) => r.id);
    expect(ids).toEqual(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"]);
    expect(new Set(ids).size).toBe(8);
  });

  it("reports no violations on the benign fixture", () => {
    const results = checkInvariants(observation());
    expect(results).toHaveLength(8);
    expect(violationsOf(results)).toEqual([]);
  });
});
