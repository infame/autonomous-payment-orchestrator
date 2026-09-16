import type { AgentProposal } from "../domain/agent-proposal.js";
import type { Intent, IntentStatus } from "../domain/intent.js";
import type { PolicyVerdict } from "../policy/verdict.js";

/**
 * The read model handed back to a use-case's caller. Deliberately not
 * `IntentProps` (`domain/intent.ts`): `IntentProps` is the aggregate's own
 * mutable internal snapshot (`Intent.toState()`/`Intent.fromState()`) —
 * handing that out invites a caller to mutate what looks like a live
 * aggregate, or to construct a fake one via `Intent.fromState`. `IntentView`
 * is a plain, read-only projection with no such capability.
 *
 * Deliberately carries no `version`: per `ports/intent-repository.ts`'s
 * header, `version` is a persistence concern, not something a client can
 * meaningfully round-trip. A future mutating use-case (e.g. `ApproveIntent`)
 * re-reads the `StoredIntent` itself and claims against the version it just
 * read — it never trusts a version handed back through a client-facing view.
 */
export interface IntentView {
  readonly id: string;
  readonly customerId: string;
  readonly text: string;
  readonly status: IntentStatus;
  readonly proposal: AgentProposal | null;
  readonly policyVerdict: PolicyVerdict | null;
  readonly durableLedgerEventId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Projects an `Intent` aggregate through its public accessors only — never its internal `toState()` snapshot. */
export function toIntentView(intent: Intent): IntentView {
  return {
    id: intent.id,
    customerId: intent.customerId,
    text: intent.text,
    status: intent.status,
    proposal: intent.proposal,
    policyVerdict: intent.policyVerdict,
    durableLedgerEventId: intent.durableLedgerEventId,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}
