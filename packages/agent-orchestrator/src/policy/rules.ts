import type { PaymentProposal } from "../domain/agent-proposal.js";
import type { PolicyObjection } from "./verdict.js";

export interface PolicyConfig {
  readonly allowedCurrencies: readonly string[];
  /** Minor units. At or above this, a proposal gates to `needs_approval` rather than auto-approving (coordinator decision #2). */
  readonly maxAutoApproveAmount: number;
  /** Minor units. Above this, a proposal is rejected outright — no approval gate can rescue it. */
  readonly maxHardLimitAmount: number;
  /** Completed intents per customer per 24h. */
  readonly dailyRateLimit: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  allowedCurrencies: ["USD", "EUR", "GBP"],
  maxAutoApproveAmount: 50_000,
  maxHardLimitAmount: 500_000,
  dailyRateLimit: 10,
};

/**
 * Currencies whose minor unit isn't 1/100th of the major unit (no decimal
 * places at all, in these cases). `extractGroundedAmounts`'s ×100
 * normalisation and every single-scalar threshold in this file (`amount`
 * compared directly against `maxAutoApproveAmount`/`maxHardLimitAmount`)
 * both assume 2-decimal minor units — allowing one of these currencies
 * through would silently misinterpret every amount compared against it.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
]);

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Merges `overrides` onto `DEFAULT_POLICY_CONFIG` and validates the result.
 * Throws a plain `Error` (prefixed "resolvePolicyConfig: ") — a
 * misconfigured SYSTEM, not a domain invariant. Same precedent as
 * `resolveRetryPolicy` in `durable-ledger`'s `retry-policy.ts`.
 */
export function resolvePolicyConfig(
  overrides?: Partial<PolicyConfig>,
): PolicyConfig {
  const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...overrides };

  if (config.allowedCurrencies.length === 0) {
    throw new Error("resolvePolicyConfig: allowedCurrencies must not be empty");
  }
  const seen = new Set<string>();
  for (const currency of config.allowedCurrencies) {
    if (!CURRENCY_CODE.test(currency)) {
      throw new Error(
        `resolvePolicyConfig: allowedCurrencies entries must be uppercase ISO-4217 alpha-3 codes, got ${JSON.stringify(currency)}`,
      );
    }
    if (seen.has(currency)) {
      throw new Error(
        `resolvePolicyConfig: allowedCurrencies must not contain duplicates, got duplicate ${JSON.stringify(currency)}`,
      );
    }
    seen.add(currency);
    if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
      throw new Error(
        `resolvePolicyConfig: allowedCurrencies must not contain a zero-decimal currency (assumes 2-decimal minor units throughout), got ${JSON.stringify(currency)}`,
      );
    }
  }

  if (
    !Number.isSafeInteger(config.maxAutoApproveAmount) ||
    config.maxAutoApproveAmount <= 0
  ) {
    throw new Error(
      `resolvePolicyConfig: maxAutoApproveAmount must be a positive safe integer, got ${String(config.maxAutoApproveAmount)}`,
    );
  }
  if (
    !Number.isSafeInteger(config.maxHardLimitAmount) ||
    config.maxHardLimitAmount <= 0
  ) {
    throw new Error(
      `resolvePolicyConfig: maxHardLimitAmount must be a positive safe integer, got ${String(config.maxHardLimitAmount)}`,
    );
  }
  // Ordering only — the spec's "order of magnitude" language is guidance,
  // not an invariant we enforce.
  if (config.maxHardLimitAmount < config.maxAutoApproveAmount) {
    throw new Error(
      `resolvePolicyConfig: maxHardLimitAmount must be >= maxAutoApproveAmount, got maxHardLimitAmount=${String(config.maxHardLimitAmount)} maxAutoApproveAmount=${String(config.maxAutoApproveAmount)}`,
    );
  }

  if (!Number.isInteger(config.dailyRateLimit) || config.dailyRateLimit < 0) {
    throw new Error(
      `resolvePolicyConfig: dailyRateLimit must be an integer >= 0, got ${String(config.dailyRateLimit)}`,
    );
  }

  return config;
}

export interface RuleInput {
  readonly proposal: PaymentProposal;
  readonly groundedAmounts: ReadonlySet<number>;
  readonly completedIntentsLast24h: number;
  readonly config: PolicyConfig;
}

export type PolicyRule = (input: RuleInput) => PolicyObjection | null;

export const currencyAllowed: PolicyRule = (input) =>
  input.config.allowedCurrencies.includes(input.proposal.currency)
    ? null
    : {
        decision: "reject",
        reason: "currency_not_allowed",
        detail: `Currency "${input.proposal.currency}" is not allowed`,
      };

/** Must read ONLY `input.proposal.amount` — never `input.proposal.reasoning` (spec §3.3, §10). */
export const amountMustBeGrounded: PolicyRule = (input) =>
  input.groundedAmounts.has(input.proposal.amount)
    ? null
    : {
        decision: "reject",
        reason: "amount_not_grounded",
        detail: "Proposed amount does not appear in the intent text",
      };

export const maxHardLimit: PolicyRule = (input) =>
  input.proposal.amount > input.config.maxHardLimitAmount
    ? {
        decision: "reject",
        reason: "hard_limit_exceeded",
        detail: `Amount exceeds the hard limit of ${String(input.config.maxHardLimitAmount)}`,
      }
    : null;

export const dailyRateLimit: PolicyRule = (input) =>
  // >= because completedIntentsLast24h counts ALREADY-completed intents,
  // and this proposal would be the (count+1)-th — keeping "completed <=
  // limit" requires count + 1 <= limit, i.e. count >= limit rejects.
  input.completedIntentsLast24h >= input.config.dailyRateLimit
    ? {
        decision: "reject",
        reason: "daily_rate_limit_exceeded",
        detail: `Daily limit of ${String(input.config.dailyRateLimit)} intents reached`,
      }
    : null;

export const maxAutoApprove: PolicyRule = (input) =>
  // coordinator decision #2: >= gates (at-threshold requires approval, does
  // not pass).
  input.proposal.amount >= input.config.maxAutoApproveAmount
    ? {
        decision: "needs_approval",
        reason: "above_auto_approve_threshold",
        detail: `Amount is at or above the auto-approve threshold of ${String(input.config.maxAutoApproveAmount)}`,
      }
    : null;

/**
 * Evaluation order IS the precedence law: every reject-capable rule runs
 * before the one needs_approval-capable rule, so a reject always wins.
 * `currencyAllowed` is first because the two amount thresholds are single
 * scalars with no FX conversion — meaningless to compare before the
 * currency is known to be an allowlisted, similarly-scaled one.
 * `amountMustBeGrounded` is second, before any limit, because a fabricated
 * amount must never be merely gated — it is always a hard reject.
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  currencyAllowed,
  amountMustBeGrounded,
  maxHardLimit,
  dailyRateLimit,
  maxAutoApprove,
];
