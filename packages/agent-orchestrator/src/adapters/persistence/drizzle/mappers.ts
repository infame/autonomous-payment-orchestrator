import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
  type AgentProposal,
} from "../../../domain/agent-proposal.js";
import { InvalidProposalError } from "../../../domain/errors.js";
import {
  Intent,
  isIntentStatus,
  type IntentStatus,
} from "../../../domain/intent.js";
import {
  isPolicyReasonCode,
  type PolicyVerdict,
} from "../../../policy/verdict.js";
import type { IntentRow, NewIntentRow } from "./schema.js";

/**
 * `Intent` -> `intents` insert/update row. `version` is a port-level
 * parameter (see `ports/intent-repository.ts`'s header), never read off the
 * `Intent` instance itself, so callers (`PgIntentRepository`,
 * `InMemoryIntentRepository`) always supply the version they intend to
 * write.
 */
export function intentToRow(intent: Intent, version: number): NewIntentRow {
  const state = intent.toState();
  return {
    id: state.id,
    customerId: state.customerId,
    intentText: state.text,
    status: state.status,
    proposal: state.proposal,
    policyVerdict: state.policyVerdict,
    durableLedgerEventId: state.durableLedgerEventId,
    version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

/**
 * `intents` row -> `Intent`. Never blind-casts `status`/`proposal`/
 * `policy_verdict` — a corrupt value read back from storage throws instead
 * of silently miscasting and letting a use-case act on a status/proposal
 * shape it never actually validated.
 */
export function rowToIntent(row: IntentRow): Intent {
  return Intent.fromState({
    id: row.id,
    customerId: row.customerId,
    text: row.intentText,
    status: parseIntentStatus(row.status),
    proposal: parseProposal(row.proposal),
    policyVerdict: parsePolicyVerdict(row.policyVerdict),
    durableLedgerEventId: row.durableLedgerEventId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parseIntentStatus(value: string): IntentStatus {
  if (!isIntentStatus(value)) {
    throw new InvalidProposalError(
      `Invalid status read back from storage: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Rebuilds through the domain's own factory functions
 * (`paymentProposal`/`clarifyProposal`/`declineProposal`) rather than
 * trusting the stored JSON shape directly — a storage round-trip re-runs
 * the exact same validation a freshly-LLM-produced proposal would, so a
 * corrupted or hand-edited row can never bypass it.
 */
function parseProposal(value: AgentProposal | null): AgentProposal | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    throw new InvalidProposalError(
      `Invalid proposal read back from storage: ${JSON.stringify(value)}`,
    );
  }
  switch (value.kind) {
    case "propose_payment":
      return paymentProposal({
        amount: value.amount,
        currency: value.currency,
        merchantId: value.merchantId,
        reasoning: value.reasoning,
      });
    case "clarify":
      return clarifyProposal(value.question);
    case "decline":
      return declineProposal(value.reason);
    default:
      throw new InvalidProposalError(
        `Invalid proposal kind read back from storage: ${JSON.stringify(
          (value as { kind?: unknown }).kind,
        )}`,
      );
  }
}

/**
 * Validates `decision`, and — for verdicts that carry a `reason` — that
 * `reason` is a recognised `PolicyReasonCode` (`isPolicyReasonCode`,
 * `policy/verdict.ts`). `detail` is human-readable free text and is not
 * further validated, same as the domain's own `PolicyVerdict` shape.
 */
function parsePolicyVerdict(value: PolicyVerdict | null): PolicyVerdict | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    throw new InvalidProposalError(
      `Invalid policy verdict read back from storage: ${JSON.stringify(value)}`,
    );
  }
  switch (value.decision) {
    case "allow":
      return { decision: "allow" };
    case "needs_approval":
    case "reject": {
      if (
        typeof value.reason !== "string" ||
        !isPolicyReasonCode(value.reason)
      ) {
        throw new InvalidProposalError(
          `Invalid policy verdict reason read back from storage: ${JSON.stringify(
            value.reason,
          )}`,
        );
      }
      if (typeof value.detail !== "string") {
        throw new InvalidProposalError(
          "Invalid policy verdict read back from storage: missing detail",
        );
      }
      return {
        decision: value.decision,
        reason: value.reason,
        detail: value.detail,
      };
    }
    default:
      throw new InvalidProposalError(
        `Invalid policy verdict decision read back from storage: ${JSON.stringify(
          (value as { decision?: unknown }).decision,
        )}`,
      );
  }
}
