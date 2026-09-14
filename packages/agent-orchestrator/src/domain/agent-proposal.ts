/**
 * The structured action an `LlmClient` (spec step 3) is obligated to return
 * — a discriminated union, never free text. `reasoning`/`question`/`reason`
 * are human-readable and MUST NOT be read by the policy layer (`src/policy`)
 * — see `evaluatePolicy`'s header. Kept in its own file, not inlined into
 * `intent.ts`, so `Intent` can depend on this shape without also pulling in
 * every future LLM-adapter concern that might grow alongside it.
 */

import { InvalidProposalError } from "./errors.js";

export interface PaymentProposal {
  readonly kind: "propose_payment";
  /** Integer, minor units (e.g. cents). See docs/adr/0011-no-third-money-copy.md. */
  readonly amount: number;
  /** ISO-4217 alpha-3, uppercase. */
  readonly currency: string;
  readonly merchantId: string;
  /** Human-readable; NEVER read by the policy layer. */
  readonly reasoning: string;
}

export interface ClarifyProposal {
  readonly kind: "clarify";
  readonly question: string;
}

export interface DeclineProposal {
  readonly kind: "decline";
  readonly reason: string;
}

export type AgentProposal = PaymentProposal | ClarifyProposal | DeclineProposal;

export const MAX_PROPOSAL_TEXT_LENGTH = 4_000;

/**
 * `merchantId` shape matches `durable-ledger`'s `LedgerAccount` subject
 * regex exactly (`packages/durable-ledger/src/domain/account.ts`) — a
 * `merchantId` here becomes a `LedgerAccount.merchant(id)` subject
 * downstream once `durable-ledger` posts against it. A value that fails
 * this check would otherwise sail past this package's own validation, sail
 * past durable-ledger's HTTP-layer Zod validation (which only checks
 * `z.string().min(1)`, see `workflow/events.ts`), and blow up deep inside
 * ledger posting instead of failing fast, close to the LLM output that
 * produced it.
 */
const MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;

function assertBoundedText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidProposalError(`${field} must not be empty`);
  }
  if (trimmed.length > MAX_PROPOSAL_TEXT_LENGTH) {
    throw new InvalidProposalError(
      `${field} must be at most ${String(MAX_PROPOSAL_TEXT_LENGTH)} characters, got ${String(trimmed.length)}`,
    );
  }
  return value;
}

export function paymentProposal(input: {
  amount: number;
  currency: string;
  merchantId: string;
  reasoning: string;
}): PaymentProposal {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new InvalidProposalError(
      `amount must be a positive safe integer (minor units), got ${String(input.amount)}`,
    );
  }
  if (!CURRENCY.test(input.currency)) {
    throw new InvalidProposalError(
      `currency must be an uppercase ISO-4217 alpha-3 code, got ${JSON.stringify(input.currency)}`,
    );
  }
  if (!MERCHANT_ID.test(input.merchantId)) {
    throw new InvalidProposalError(
      `merchantId must match ${MERCHANT_ID.toString()}, got ${JSON.stringify(input.merchantId)}`,
    );
  }
  assertBoundedText(input.reasoning, "reasoning");
  return {
    kind: "propose_payment",
    amount: input.amount,
    currency: input.currency,
    merchantId: input.merchantId,
    reasoning: input.reasoning,
  };
}

export function clarifyProposal(question: string): ClarifyProposal {
  assertBoundedText(question, "question");
  return { kind: "clarify", question };
}

export function declineProposal(reason: string): DeclineProposal {
  assertBoundedText(reason, "reason");
  return { kind: "decline", reason };
}

export function isPaymentProposal(
  proposal: AgentProposal,
): proposal is PaymentProposal {
  return proposal.kind === "propose_payment";
}
