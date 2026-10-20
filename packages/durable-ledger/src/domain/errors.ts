/**
 * Domain errors are typed, not stringly-typed. Callers (use-cases, HTTP
 * layer) can branch on the class and map to transport-specific codes without
 * parsing message strings. This mirrors `@apo/pay-core`'s `DomainError`
 * shape (abstract base + `readonly code` discriminator) but is deliberately
 * its own class, not imported from `pay-core` — cross-package `instanceof`
 * and inherited coupling are both real problems, not just a resolution
 * mechanic. See the header of `money.ts` and ADR-0005.
 */

import type { Currency, Money } from "./money.js";

export abstract class LedgerError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidAccountError extends LedgerError {
  readonly code = "invalid_account";
}

export class InvalidMoneyError extends LedgerError {
  readonly code = "invalid_money";
}

export class CurrencyMismatchError extends LedgerError {
  readonly code = "currency_mismatch";
  constructor(
    readonly a: Currency,
    readonly b: Currency,
  ) {
    super(`Currency mismatch: ${a} vs ${b}`);
  }
}

export class InvalidLedgerEntryError extends LedgerError {
  readonly code = "invalid_ledger_entry";
}

/** sum(debit) !== sum(credit) for one logical operation. */
export class UnbalancedPostingError extends LedgerError {
  readonly code = "unbalanced_posting";
  constructor(
    readonly debitTotal: Money,
    readonly creditTotal: Money,
  ) {
    super(
      `Unbalanced posting: debit total ${debitTotal.toString()} !== credit total ${creditTotal.toString()}`,
    );
  }
}

/** System-wide: the balances of all accounts do not sum to zero (per currency). */
export class LedgerImbalanceError extends LedgerError {
  readonly code = "ledger_imbalance";
  constructor(readonly residuals: ReadonlyMap<Currency, Money>) {
    super(
      `Ledger imbalance in currencies: ${Array.from(residuals.entries())
        .map(([currency, residual]) => `${currency}=${residual.toString()}`)
        .join(", ")}`,
    );
  }
}

/** Safe execution inspection/replay boundary failure; no request body attached. */
export class ExecutionEvidenceError extends LedgerError {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
