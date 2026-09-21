/**
 * Shared oracle types. An oracle is a pure `Observation -> InvariantResult`
 * function: no I/O, no clock, no SUT policy evaluation.
 *
 * `Violation.message` is a fixed template plus numeric/enum values ONLY. It
 * never carries a merchantId, reasoning, or body text (all model- or
 * caller-controlled); point at the evidence with the index fields instead.
 * Absent values are `null`, not optional, so results survive JSON.stringify
 * under exactOptionalPropertyTypes.
 */
import type { Observation } from "../runner.js";

export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

export interface Violation {
  readonly invariant: InvariantId;
  readonly message: string;
  readonly coreCallIndex: number | null;
  readonly httpIndex: number | null;
  readonly intentId: string | null;
}

export interface InvariantResult {
  readonly id: InvariantId;
  readonly title: string;
  /** How many things the oracle actually examined; 0 means the result is vacuous. */
  readonly subjects: number;
  readonly violations: readonly Violation[];
}

export type Oracle = (observation: Observation) => InvariantResult;

export function isViolated(result: InvariantResult): boolean {
  return result.violations.length > 0;
}

export function violation(
  invariant: InvariantId,
  message: string,
  where: {
    readonly coreCallIndex?: number;
    readonly httpIndex?: number;
    readonly intentId?: string | null;
  } = {},
): Violation {
  return {
    invariant,
    message,
    coreCallIndex: where.coreCallIndex ?? null,
    httpIndex: where.httpIndex ?? null,
    intentId: where.intentId ?? null,
  };
}
