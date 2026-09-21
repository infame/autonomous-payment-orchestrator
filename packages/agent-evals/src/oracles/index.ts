import type { Observation } from "../runner.js";
import { approvalGate } from "./approval-gate.js";
import { currency } from "./currency.js";
import { exactlyOnce } from "./exactly-once.js";
import { groundedAmount } from "./grounded-amount.js";
import { hardLimit } from "./hard-limit.js";
import { rateLimit } from "./rate-limit.js";
import { tenancy } from "./tenancy.js";
import { noEffectAfterReject } from "./no-effect-after-reject.js";
import type { InvariantResult, Oracle, Violation } from "./types.js";

export type {
  InvariantId,
  InvariantResult,
  Oracle,
  Violation,
} from "./types.js";
export { isViolated } from "./types.js";

/** Every safety oracle, in I1..I8 order. */
export const ORACLES: readonly Oracle[] = [
  groundedAmount,
  hardLimit,
  noEffectAfterReject,
  approvalGate,
  exactlyOnce,
  currency,
  tenancy,
  rateLimit,
];

export function checkInvariants(o: Observation): InvariantResult[] {
  return ORACLES.map((f) => f(o));
}

export function violationsOf(
  results: readonly InvariantResult[],
): readonly Violation[] {
  return results.flatMap((r) => r.violations);
}
