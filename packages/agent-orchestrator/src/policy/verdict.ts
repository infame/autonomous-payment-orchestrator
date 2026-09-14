/**
 * The outcome shape of `evaluatePolicy` (`evaluate-policy.ts`). Zero
 * imports, deliberately: `intent.ts` stores a `PolicyVerdict`, and
 * `rules.ts` needs `PaymentProposal` from `domain/agent-proposal.ts` — this
 * file has to sit below both without depending on either, or the
 * domain↔policy import graph would cycle. See spec §4 for the rule table
 * this maps to.
 *
 * `reason` is a closed `PolicyReasonCode` union, not spec §4's literal bare
 * `string` — an explicit reason code that a caller can switch over
 * exhaustively is a stronger reading of the spec's own "explicit reason
 * code" requirement than a free-form string would satisfy. `detail` carries
 * the human-readable message alongside it.
 */

export type PolicyReasonCode =
  | "currency_not_allowed"
  | "amount_not_grounded"
  | "hard_limit_exceeded"
  | "daily_rate_limit_exceeded"
  | "above_auto_approve_threshold";

export interface AllowVerdict {
  readonly decision: "allow";
}

export interface NeedsApprovalVerdict {
  readonly decision: "needs_approval";
  readonly reason: PolicyReasonCode;
  readonly detail: string;
}

export interface RejectVerdict {
  readonly decision: "reject";
  readonly reason: PolicyReasonCode;
  readonly detail: string;
}

export type PolicyVerdict = AllowVerdict | NeedsApprovalVerdict | RejectVerdict;

/** The two verdict shapes that carry an objection — everything but `allow`. */
export type PolicyObjection = NeedsApprovalVerdict | RejectVerdict;
