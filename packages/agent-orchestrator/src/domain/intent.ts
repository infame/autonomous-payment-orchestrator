/**
 * One processed natural-language intent. Discriminated union by status,
 * same principle as `Payment` in `@apo/pay-core` (no XState, exhaustive
 * transitions, no hidden mutation): guard-clause transition methods on a
 * class, `status` a string-literal union field. See spec §3.1.
 *
 * Legal transitions:
 *
 *   received            ──▶ needs_clarification   (LLM: ambiguous)
 *   received            ──▶ proposed               (LLM: unambiguous)
 *   received            ──▶ rejected               (LLM: declines outright — extension, see declineByAgent)
 *   needs_clarification ──▶ proposed               (clarification resolved the ambiguity)
 *   needs_clarification ──▶ rejected               (LLM still declines, or the answer looks like manipulation)
 *   proposed            ──▶ needs_approval         (policy: limit/gate)
 *   proposed            ──▶ rejected               (policy: hard reject)
 *   proposed            ──▶ executing              (policy: auto-approved)
 *   needs_approval       ──▶ executing             (explicit approval granted)
 *   needs_approval       ──▶ rejected              (explicitly rejected)
 *   executing            ──▶ completed | failed | needs_review   (per durable-ledger's answer)
 *
 * Only one round of clarification: there is no `needs_clarification →
 * needs_clarification` transition. If the user's answer still doesn't
 * resolve the ambiguity, or looks like manipulation, the intent is
 * `rejected`, not re-asked — spec §3.1's explicitly recorded simplification,
 * not a forgotten edge.
 *
 * `recordClarificationAnswer` is deliberately NOT one of the transitions
 * above: it stores the user's answer to a clarification question but leaves
 * `status` at `needs_clarification` — the actual `needs_clarification →
 * proposed | rejected` transition still happens separately (via `propose`/
 * `declineByAgent`), once a use-case has re-asked the `LlmClient` with the
 * answer in hand. It's legal only from `needs_clarification`, and it can be
 * called at most once per intent (a second call throws `InvalidIntentError`,
 * not `InvalidIntentStateError` — the status hasn't changed, so a "wrong
 * state" error would be misleading). Once answered, re-entry into
 * `needs_clarification` is structurally impossible — there is no transition
 * back into it from anywhere — so the "already set" guard, combined with the
 * status check, is sufficient on its own; no version/sequence field is
 * needed to prevent a stale double-write. This mirrors spec §3.1's "only one
 * round" rule for `clarify` itself, applied to the answer side of that same
 * round.
 *
 * Why `executing` is only reachable with a `durableLedgerEventId` already in
 * hand: `autoApprove`/`approve` accept the id as a required parameter and
 * write it in the very same mutation that flips `status` to `executing` —
 * there is no way to observe `status === "executing"` with a null
 * `durableLedgerEventId`, because the two fields are set atomically
 * together, not in two steps that could drift apart. This holds
 * independently of whether `durable-ledger` itself is idempotent — it now
 * is, optionally, via a caller-supplied `Idempotency-Key` on
 * `POST /workflows/payment` (`@apo/durable-ledger`'s ADR-0013), but that is
 * a property of the OTHER side of the boundary, not of this atomic write.
 * What this guarantees, on its own, is narrower and purely local: the handle
 * to whatever workflow run was triggered and the record of having triggered
 * it can never disagree with each other on a single `Intent`. Preventing
 * two concurrent calls into a use-case from both passing this guard for the
 * same `Intent` — the other half of spec §6's exactly-once requirement — is
 * a repository/use-case concern (the optimistic-lock `version` check,
 * spec steps 5/6), not something this class can enforce by itself.
 *
 * Why there is no `failureReason`/`rejectionReason` field: the cause of a
 * `rejected` intent is always derivable from the persisted row alone, via
 * exactly one of four routes, distinguishable by `policyVerdict` and
 * `proposal` together:
 *
 *   - `proposed → rejected` (policy hard reject, `rejectByPolicy`):
 *     `policyVerdict.decision === "reject"`.
 *   - `needs_approval → rejected` (explicit human rejection,
 *     `rejectByApprover`): `policyVerdict?.decision === "needs_approval"`.
 *     `rejectByApprover` does NOT clear `policyVerdict` — it stays exactly
 *     as `requireApproval` set it (the `needs_approval` verdict that opened
 *     the approval gate in the first place), so this is the unique
 *     discriminator for a human rejection: no other route into `rejected`
 *     can leave `policyVerdict.decision === "needs_approval"` behind, since
 *     `requireApproval` is the only transition that ever writes that
 *     decision, and it's a dead end for anything except `rejectByApprover`/
 *     `approve`.
 *   - `received → rejected` (agent declines on its first pass,
 *     `declineByAgent`): `policyVerdict === null && proposal?.kind ===
 *     "decline" && clarificationAnswer === null`.
 *   - `needs_clarification → rejected` (agent declines after the
 *     clarification round, `declineByAgent`, including the synthetic
 *     second-clarify decline): `policyVerdict === null && proposal?.kind
 *     === "decline" && clarificationAnswer !== null`.
 *
 * The cause of a `failed`/`needs_review` intent lives in
 * `durable-ledger`/Inngest, reachable via `durableLedgerEventId`. Storing a
 * duplicate summary here would be a stale copy of another system's truth —
 * the same principle `durable-ledger`'s ADR-0010 already established for not
 * building a local `workflow_runs` table.
 */

import type {
  AgentProposal,
  ClarifyProposal,
  DeclineProposal,
  PaymentProposal,
} from "./agent-proposal.js";
import { isPaymentProposal } from "./agent-proposal.js";
import type {
  AllowVerdict,
  NeedsApprovalVerdict,
  PolicyVerdict,
  RejectVerdict,
} from "../policy/verdict.js";
import { InvalidIntentError, InvalidIntentStateError } from "./errors.js";

export type IntentStatus =
  | "received"
  | "needs_clarification"
  | "proposed"
  | "needs_approval"
  | "rejected"
  | "executing"
  | "completed"
  | "failed"
  | "needs_review";

export const TERMINAL_INTENT_STATUSES: ReadonlySet<IntentStatus> = new Set([
  "rejected",
  "completed",
  "failed",
  "needs_review",
]);

/** Every legal `IntentStatus`, in the same order as the transition diagram above. */
export const INTENT_STATUSES: readonly IntentStatus[] = [
  "received",
  "needs_clarification",
  "proposed",
  "needs_approval",
  "rejected",
  "executing",
  "completed",
  "failed",
  "needs_review",
];

/** Narrows a value read back from storage (or the wire) to `IntentStatus`. */
export function isIntentStatus(value: string): value is IntentStatus {
  return (INTENT_STATUSES as readonly string[]).includes(value);
}

export const MAX_INTENT_TEXT_LENGTH = 10_000;

export const MAX_CLARIFICATION_ANSWER_LENGTH = 2_000;

/** Same shape as `durable-ledger`'s account-subject ids: a reasonable, bounded id, not free text. */
export const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface IntentProps {
  readonly id: string;
  readonly customerId: string;
  readonly text: string;
  status: IntentStatus;
  proposal: AgentProposal | null;
  policyVerdict: PolicyVerdict | null;
  durableLedgerEventId: string | null;
  clarificationAnswer: string | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

export class Intent {
  private constructor(private readonly props: IntentProps) {}

  // ── Construction ─────────────────────────────────────────────────────────

  /** Create a brand-new intent in the `received` state. */
  static submit(params: {
    id: string;
    customerId: string;
    text: string;
    now?: Date;
  }): Intent {
    if (params.id.trim().length === 0) {
      throw new InvalidIntentError("id must not be empty");
    }
    if (!CUSTOMER_ID_PATTERN.test(params.customerId)) {
      throw new InvalidIntentError(
        `customerId must match ${CUSTOMER_ID_PATTERN.toString()}, got ${JSON.stringify(params.customerId)}`,
      );
    }
    const trimmedText = params.text.trim();
    if (trimmedText.length === 0) {
      throw new InvalidIntentError("text must not be empty");
    }
    if (trimmedText.length > MAX_INTENT_TEXT_LENGTH) {
      throw new InvalidIntentError(
        `text must be at most ${String(MAX_INTENT_TEXT_LENGTH)} characters, got ${String(trimmedText.length)}`,
      );
    }
    const now = params.now ?? new Date();
    return new Intent({
      id: params.id,
      customerId: params.customerId,
      text: params.text,
      status: "received",
      proposal: null,
      policyVerdict: null,
      durableLedgerEventId: null,
      clarificationAnswer: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Rehydrate an existing intent from storage. No validation — the repository/mapper owns validity of stored rows. */
  static fromState(props: IntentProps): Intent {
    return new Intent({ ...props });
  }

  // ── Transitions ─────────────────────────────────────────────────────────

  /** received → needs_clarification. */
  clarify(proposal: ClarifyProposal, now: Date = new Date()): void {
    this.assertStatus(["received"], "clarify");
    this.props.status = "needs_clarification";
    this.props.proposal = proposal;
    this.touch(now);
  }

  /**
   * Records the user's answer to a clarification question. NOT a status
   * transition — `status` stays `needs_clarification`; see class header for
   * why. Legal only from `needs_clarification`, and only once: a second call
   * throws `InvalidIntentError` (the answer is already set), not
   * `InvalidIntentStateError` (the status guard already passed). Stores
   * `answer` verbatim (untrimmed) — the trim is only used to validate
   * blankness/length, mirroring `Intent.submit`'s treatment of `text`.
   */
  recordClarificationAnswer(answer: string, now: Date = new Date()): void {
    this.assertStatus(["needs_clarification"], "recordClarificationAnswer");
    if (this.props.clarificationAnswer !== null) {
      throw new InvalidIntentError("clarificationAnswer is already set");
    }
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      throw new InvalidIntentError("clarificationAnswer must not be empty");
    }
    if (trimmed.length > MAX_CLARIFICATION_ANSWER_LENGTH) {
      throw new InvalidIntentError(
        `clarificationAnswer must be at most ${String(MAX_CLARIFICATION_ANSWER_LENGTH)} characters, got ${String(trimmed.length)}`,
      );
    }
    this.props.clarificationAnswer = answer;
    this.touch(now);
  }

  /** received | needs_clarification → proposed. */
  propose(proposal: PaymentProposal, now: Date = new Date()): void {
    this.assertStatus(["received", "needs_clarification"], "propose");
    this.props.status = "proposed";
    this.props.proposal = proposal;
    this.touch(now);
  }

  /**
   * received | needs_clarification → rejected.
   *
   * `received` as a source status is an extension beyond spec §3.1's literal
   * transition table: an LLM can decline on its very first call (§3.2),
   * not only after a clarification round — without this edge a first-pass
   * decline would have no legal destination.
   */
  declineByAgent(proposal: DeclineProposal, now: Date = new Date()): void {
    this.assertStatus(["received", "needs_clarification"], "declineByAgent");
    this.props.status = "rejected";
    this.props.proposal = proposal;
    this.touch(now);
  }

  /** proposed → needs_approval. */
  requireApproval(verdict: NeedsApprovalVerdict, now: Date = new Date()): void {
    this.assertStatus(["proposed"], "requireApproval");
    this.props.status = "needs_approval";
    this.props.policyVerdict = verdict;
    this.touch(now);
  }

  /** proposed → rejected (policy hard reject). */
  rejectByPolicy(verdict: RejectVerdict, now: Date = new Date()): void {
    this.assertStatus(["proposed"], "rejectByPolicy");
    this.props.status = "rejected";
    this.props.policyVerdict = verdict;
    this.touch(now);
  }

  /** needs_approval → rejected (explicit human rejection). */
  rejectByApprover(now: Date = new Date()): void {
    this.assertStatus(["needs_approval"], "rejectByApprover");
    this.props.status = "rejected";
    this.touch(now);
  }

  /** proposed → executing (policy auto-approved). Fixes `durableLedgerEventId` — see class header. */
  autoApprove(
    params: { verdict: AllowVerdict; durableLedgerEventId: string },
    now: Date = new Date(),
  ): void {
    this.assertStatus(["proposed"], "autoApprove");
    this.props.status = "executing";
    this.props.policyVerdict = params.verdict;
    this.props.durableLedgerEventId = params.durableLedgerEventId;
    this.touch(now);
  }

  /** needs_approval → executing (explicit human approval). Fixes `durableLedgerEventId` — see class header. */
  approve(durableLedgerEventId: string, now: Date = new Date()): void {
    this.assertStatus(["needs_approval"], "approve");
    this.props.status = "executing";
    this.props.durableLedgerEventId = durableLedgerEventId;
    this.touch(now);
  }

  /** executing → completed. */
  complete(now: Date = new Date()): void {
    this.assertStatus(["executing"], "complete");
    this.props.status = "completed";
    this.touch(now);
  }

  /** executing → failed. */
  fail(now: Date = new Date()): void {
    this.assertStatus(["executing"], "fail");
    this.props.status = "failed";
    this.touch(now);
  }

  /** executing → needs_review. */
  flagForReview(now: Date = new Date()): void {
    this.assertStatus(["executing"], "flagForReview");
    this.props.status = "needs_review";
    this.touch(now);
  }

  // ── Guards ──────────────────────────────────────────────────────────────

  private assertStatus(
    allowed: readonly IntentStatus[],
    attempted: string,
  ): void {
    if (!allowed.includes(this.props.status)) {
      throw new InvalidIntentStateError(this.props.status, attempted);
    }
  }

  private touch(now: Date): void {
    this.props.updatedAt = now;
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  get id(): string {
    return this.props.id;
  }
  get customerId(): string {
    return this.props.customerId;
  }
  get text(): string {
    return this.props.text;
  }
  get status(): IntentStatus {
    return this.props.status;
  }
  get proposal(): AgentProposal | null {
    return this.props.proposal;
  }
  get paymentProposal(): PaymentProposal | null {
    return this.props.proposal !== null &&
      isPaymentProposal(this.props.proposal)
      ? this.props.proposal
      : null;
  }
  get policyVerdict(): PolicyVerdict | null {
    return this.props.policyVerdict;
  }
  get durableLedgerEventId(): string | null {
    return this.props.durableLedgerEventId;
  }
  get clarificationAnswer(): string | null {
    return this.props.clarificationAnswer;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get isTerminal(): boolean {
    return TERMINAL_INTENT_STATUSES.has(this.props.status);
  }

  /** Snapshot for persistence. */
  toState(): IntentProps {
    return { ...this.props };
  }
}
