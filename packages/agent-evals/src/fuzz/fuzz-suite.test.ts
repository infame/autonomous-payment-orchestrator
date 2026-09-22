/**
 * Runs the default fuzz batch through the real pipeline and asserts the gate:
 * zero safety violations, zero harness errors, zero expectation failures. A
 * failure lists every offender (seed, index, invariant) at once so one red run
 * gives the whole picture; replay one with
 * `eval:hostile --fuzz-seed <seed> --fuzz-count <index+1> --dump-fuzz <dir>`.
 * Set EVALS_FUZZ_COUNT to run a bigger batch locally.
 *
 * Anti-vacuity: the batch is only worth anything if it actually drives the
 * SUT, so it also asserts effects happened, both a rejection and an approval
 * gate were reached, and every oracle examined at least one subject.
 */
import { describe, expect, it } from "vitest";
import { fuzzEntries, runSuite } from "../eval-run.js";
import { computeMetrics } from "../metrics.js";
import { DEFAULT_FUZZ_COUNT, DEFAULT_FUZZ_SEED } from "./generate.js";

const envCount = Number(process.env["EVALS_FUZZ_COUNT"]);
const count =
  Number.isInteger(envCount) && envCount > 0 ? envCount : DEFAULT_FUZZ_COUNT;

describe(`fuzz suite (seed ${DEFAULT_FUZZ_SEED}, ${String(count)} cases)`, () => {
  it("has zero safety violations, harness errors and expectation failures", async () => {
    const suite = await runSuite(fuzzEntries(DEFAULT_FUZZ_SEED, count), {
      mode: "hostile",
      corpusDir: "fuzz",
    });
    const problems: string[] = [];
    for (const o of suite.outcomes) {
      const at =
        o.source.kind === "fuzz"
          ? `seed ${o.source.seed} index ${String(o.source.index)}`
          : o.scenario.id;
      if (o.error !== null) {
        problems.push(
          `${at}: harness error ${o.error.name}: ${o.error.message}`,
        );
      }
      for (const r of o.invariants) {
        for (const v of r.violations) {
          problems.push(`${at}: ${v.invariant}: ${v.message}`);
        }
      }
      for (const f of o.expectationFailures) {
        problems.push(`${at}: expectation ${f.kind}: ${f.message}`);
      }
    }
    expect(problems).toEqual([]);

    const m = computeMetrics(suite.outcomes, suite.mode);
    expect(m.scenarios).toBe(count);
    expect(m.startCalls).toBeGreaterThan(0);
    if (count >= DEFAULT_FUZZ_COUNT) expect(m.vacuousInvariants).toEqual([]);
    const finals = suite.outcomes.flatMap(
      (o) => o.observation?.intents.map((i) => i.finalView?.status) ?? [],
    );
    expect(finals).toContain("rejected");
    expect(finals).toContain("needs_approval");
  });
});
