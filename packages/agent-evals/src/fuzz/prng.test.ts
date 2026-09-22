import { describe, expect, it } from "vitest";
import { hashSeed, rngFor } from "./prng.js";

const stream = (seed: string, index: number, n = 8): number[] => {
  const rng = rngFor(seed, index);
  return Array.from({ length: n }, () => rng());
};

describe("hashSeed", () => {
  it("is pinned to a literal so a platform or algorithm change is loud", () => {
    expect(hashSeed("apo-2026-09")).toBe(568817120);
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });

  it("pins the first draw of the default seed at index 0", () => {
    expect(rngFor("apo-2026-09", 0)()).toBe(0.6358559303916991);
  });
});

describe("rngFor", () => {
  it("replays the same stream for the same seed and index", () => {
    expect(stream("s", 3)).toEqual(stream("s", 3));
  });

  it("gives each index its own stream and each seed its own", () => {
    expect(stream("s", 3)).not.toEqual(stream("s", 4));
    expect(stream("s", 3)).not.toEqual(stream("t", 3));
  });

  it("draws floats in [0, 1)", () => {
    const rng = rngFor("floats", 0);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int stays inside its inclusive range and reaches both ends", () => {
    const rng = rngFor("ints", 0);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(rng.int(3, 7));
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it("weighted never picks a zero-weight item and follows the weights roughly", () => {
    const rng = rngFor("weights", 0);
    const counts = { a: 0, b: 0, z: 0 };
    for (let i = 0; i < 4000; i += 1) {
      counts[
        rng.weighted<"a" | "b" | "z">([
          [3, "a"],
          [1, "b"],
          [0, "z"],
        ])
      ] += 1;
    }
    expect(counts.z).toBe(0);
    expect(counts.a).toBeGreaterThan(counts.b * 2);
  });

  it("pick returns a member and bool honours the extremes; pick of nothing throws", () => {
    const rng = rngFor("misc", 0);
    expect(["x", "y"]).toContain(rng.pick(["x", "y"]));
    expect(rng.bool(0)).toBe(false);
    expect(rng.bool(1)).toBe(true);
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
