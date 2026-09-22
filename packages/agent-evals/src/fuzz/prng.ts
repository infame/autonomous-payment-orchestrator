/**
 * Seeded PRNG for the fuzz layer: mulberry32 over a uint32 state, no BigInt
 * and no dependency. Every value is normalised with `>>> 0`/`Math.imul`, so
 * the stream is identical on every platform and Node version.
 *
 * Replay law: `rngFor(seed, index)` is a pure function of `(seed, index)`.
 * The same pair always yields the same stream and each index has its own
 * independent stream, so case `i` never depends on how many cases were drawn
 * before it. That is what makes a fuzz finding replayable from
 * `--fuzz-seed <seed>` and an index alone.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  (): number;
  /** Uniform integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number;
  /** Uniform element; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** Element chosen proportionally to its (non-negative) weight. */
  weighted<T>(items: readonly (readonly [weight: number, value: T])[]): T;
  /** True with the given probability. */
  bool(probability: number): boolean;
}

const GOLDEN = 0x9e3779b1;

/** murmur3 32-bit finalizer: a bijection on uint32. */
function mix32(input: number): number {
  let x = input >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** FNV-1a over UTF-16 code units, then mixed; uint32. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

export function rngFor(seed: string, index: number): Rng {
  let state = mix32((hashSeed(seed) + Math.imul(index, GOLDEN)) >>> 0);
  const draw = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(draw, {
    int: (minInclusive: number, maxInclusive: number): number =>
      minInclusive + Math.floor(draw() * (maxInclusive - minInclusive + 1)),
    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(draw() * items.length)];
      if (item === undefined) throw new RangeError("pick from an empty list");
      return item;
    },
    weighted: <T>(items: readonly (readonly [number, T])[]): T => {
      const total = items.reduce((sum, [w]) => sum + w, 0);
      let ticket = draw() * total;
      for (const [w, value] of items) {
        if (ticket < w) return value;
        ticket -= w;
      }
      const last = items.at(-1);
      if (last === undefined) throw new RangeError("weighted over no items");
      return last[1];
    },
    bool: (probability: number): boolean => draw() < probability,
  });
}
