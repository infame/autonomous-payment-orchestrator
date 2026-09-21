/**
 * Attribution helpers shared by the oracles (pure).
 *
 * Attribution is ALWAYS core call -> HTTP exchange -> intent, never via
 * `RecordedStartCall.idempotencyKey`: that key is SUT-controlled
 * (ApproveIntent/AutoApproveIntent pass intent.id as the ledger key), so
 * trusting it would let the SUT vouch for itself. A core call that maps to no
 * exchange returns null; callers must treat that as a violation, never skip it.
 *
 * Sound only because the runner awaits exchanges sequentially and `as` is
 * id-addressed-only.
 */
import { extractGroundedAmounts } from "@apo/agent-orchestrator";
import { isStartCall } from "../core/recording-agent-core-client.js";
import type { RecordedStartCall } from "../core/recording-agent-core-client.js";
import type { HttpExchange, Observation } from "../runner.js";

export function startCalls(o: Observation): readonly RecordedStartCall[] {
  return o.coreCalls.filter(isStartCall);
}

/** `absIdx` is an ABSOLUTE journal index (RecordedCoreCall.index). */
export function exchangeOfCoreCall(
  o: Observation,
  absIdx: number,
): HttpExchange | null {
  return o.http.find((x) => x.coreCallIndexes.includes(absIdx)) ?? null;
}

export function intentIdOfCoreCall(
  o: Observation,
  absIdx: number,
): string | null {
  return exchangeOfCoreCall(o, absIdx)?.intentId ?? null;
}

/**
 * Union of the amounts grounded in the ORIGINAL text and in each accepted
 * clarification answer. Extracted per string, never over a concatenation
 * (which could fuse digits across the seam).
 */
export function groundedAmounts(o: Observation): ReadonlySet<number> {
  const out = new Set<number>();
  for (const s of [o.text, ...o.clarificationAnswers]) {
    for (const a of extractGroundedAmounts(s)) out.add(a);
  }
  return out;
}

export function isForeign(o: Observation, x: HttpExchange): boolean {
  return x.customerId !== o.customerId;
}
