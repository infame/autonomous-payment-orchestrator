/**
 * Domain errors are typed, not stringly-typed. Callers (use-cases, HTTP
 * layer) can branch on the class and map to transport-specific codes without
 * parsing message strings. This mirrors `@apo/pay-core`'s `DomainError` and
 * `@apo/durable-ledger`'s `LedgerError` shape (abstract base + `readonly
 * code` discriminator) but is deliberately its own class, not imported from
 * either — cross-package `instanceof` and inherited coupling are both real
 * problems, not just a resolution mechanic. See `durable-ledger/src/domain/errors.ts`.
 */

import type { IntentStatus } from "./intent.js";

export abstract class OrchestratorError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A transition the Intent's current state forbids. Maps to HTTP 422 (spec §9). */
export class InvalidIntentStateError extends OrchestratorError {
  readonly code = "invalid_intent_state";
  constructor(
    readonly from: IntentStatus,
    readonly attempted: string,
  ) {
    super(`Cannot ${attempted} an intent in state "${from}"`);
  }
}

/** Intent construction input failed validation (id/customerId/text). */
export class InvalidIntentError extends OrchestratorError {
  readonly code = "invalid_intent";
}

/** An AgentProposal failed domain validation — the LLM returned a malformed structure. */
export class InvalidProposalError extends OrchestratorError {
  readonly code = "invalid_proposal";
}

// Deliberately absent:
// - `IntentNotFoundError` — needs a repository (spec step 5).
// - `PolicyRejectedError` — not an error per spec §9: a policy `reject` is a
//   normal return value (`PolicyVerdict`), never thrown.
// - `LlmUnavailableError` — a port error, belongs with the `LlmClient` port
//   (spec step 3), not the domain.
