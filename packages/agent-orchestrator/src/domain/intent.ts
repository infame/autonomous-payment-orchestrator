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
 * Why `executing` is only reachable with a `durableLedgerEventId` already in
 * hand: this is the domain half of spec §6's exactly-once guarantee against
 * `durable-ledger`'s `POST /workflows/payment` not accepting an
 * `Idempotency-Key`. `autoApprove`/`approve` accept the id as a required
 * parameter and store it in the same mutation that flips `status` to
 * `executing` — there is no way to observe `status === "executing"` with a
 * null `durableLedgerEventId`. The other half of the guarantee (an atomic
 * check-and-persist so two concurrent calls into a use-case can't both pass
 * this guard for the same Intent) is a repository/use-case concern, landing
 * in spec steps 5/6, not here.
 *
 * Why there is no `failureReason`/`rejectionReason` field: the cause of a
 * `rejected` intent is always derivable three ways through the public API —
 * `proposal?.kind === "decline"` means the agent declined; `policyVerdict
 * ?.decision === "reject"` means policy rejected; neither means a human
 * rejected it via `rejectByApprover`. The cause of a `failed`/`needs_review`
 * intent lives in `durable-ledger`/Inngest, reachable via
 * `durableLedgerEventId`. Storing a duplicate summary here would be a stale
 * copy of another system's truth — the same principle `durable-ledger`'s
 * ADR-0010 already established for not building a local `workflow_runs`
 * table.
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

export const MAX_INTENT_TEXT_LENGTH = 10_000;

/** Same shape as `durable-ledger`'s account-subject ids: a reasonable, bounded id, not free text. */
const CUSTOMER_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface IntentProps {
  readonly id: string;
  readonly customerId: string;
  readonly text: string;
  status: IntentStatus;
  proposal: AgentProposal | null;
  policyVerdict: PolicyVerdict | null;
  durableLedgerEventId: string | null;
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
    if (!CUSTOMER_ID.test(params.customerId)) {
      throw new InvalidIntentError(
        `customerId must match ${CUSTOMER_ID.toString()}, got ${JSON.stringify(params.customerId)}`,
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
