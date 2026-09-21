/**
 * Scenario expectation comparator. NOT an oracle: it judges a scenario's own
 * claim about what should happen (terminal status, effect count, ...), never a
 * safety invariant, and `checkInvariants` never consults it. A scenario can
 * satisfy its expectations while violating an invariant and vice versa; the
 * corpus test asserts both are clean.
 *
 * Messages carry reason codes and numbers only: never `policyVerdict.detail`
 * or `proposal.reasoning` (model/caller-controlled prose).
 */
import { isStartCall } from "./core/recording-agent-core-client.js";
import type { InvariantResult } from "./oracles/index.js";
import type { Observation } from "./runner.js";
import type { Scenario } from "./scenario.js";

export interface ExpectationFailure {
  readonly kind:
    | "no_intents"
    | "terminal"
    | "core_calls"
    | "rejection_reason"
    | "start_amounts"
    | "vacuous_invariant";
  readonly message: string;
}

export function checkExpectations(
  scenario: Scenario,
  observation: Observation,
  results: readonly InvariantResult[],
): readonly ExpectationFailure[] {
  const expected = scenario.expect;
  const failures: ExpectationFailure[] = [];

  if (observation.intents.length === 0) {
    failures.push({
      kind: "no_intents",
      message: "the run observed no intents",
    });
  }

  for (const [n, intent] of observation.intents.entries()) {
    const status = intent.finalView?.status;
    if (status === undefined || !expected.terminal.includes(status)) {
      failures.push({
        kind: "terminal",
        message: `intent ${String(n)} final status ${status ?? "(no view)"} is not in [${expected.terminal.join(", ")}]`,
      });
    }
  }

  const starts = observation.coreCalls.filter(isStartCall);
  if (
    starts.length < expected.coreCalls.min ||
    starts.length > expected.coreCalls.max
  ) {
    failures.push({
      kind: "core_calls",
      message: `${String(starts.length)} start call(s), expected between ${String(expected.coreCalls.min)} and ${String(expected.coreCalls.max)}`,
    });
  }

  if (expected.rejectionReason !== undefined) {
    const verdict = observation.intents[0]?.finalView?.policyVerdict;
    if (
      verdict?.decision !== "reject" ||
      verdict.reason !== expected.rejectionReason
    ) {
      failures.push({
        kind: "rejection_reason",
        message: `expected a reject verdict with reason ${expected.rejectionReason}, got ${
          verdict === null || verdict === undefined
            ? "no verdict"
            : verdict.decision === "allow"
              ? "allow"
              : `${verdict.decision}/${verdict.reason}`
        }`,
      });
    }
  }

  if (expected.startAmounts !== undefined) {
    const actual = starts.map((c) => c.request.amount);
    const same =
      actual.length === expected.startAmounts.length &&
      actual.every((a, i) => a === expected.startAmounts?.[i]);
    if (!same) {
      failures.push({
        kind: "start_amounts",
        message: `start amounts [${actual.join(", ")}], expected [${expected.startAmounts.join(", ")}]`,
      });
    }
  }

  for (const id of expected.nonVacuous ?? []) {
    const subjects = results.find((r) => r.id === id)?.subjects ?? 0;
    if (subjects <= 0) {
      failures.push({
        kind: "vacuous_invariant",
        message: `${id} examined no subjects`,
      });
    }
  }

  return failures;
}
