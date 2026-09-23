/**
 * Domain errors are typed, not stringly-typed — a `code` discriminator,
 * matching `packages/pay-core/src/domain/errors.ts` (CLAUDE.md's own
 * project-wide convention). Callers (the gateway HTTP layer) branch on the
 * class, never on `.message`.
 */

export abstract class OrchestraError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A grant token failed HMAC verification, was malformed, or referenced a `jti` this signature doesn't cover. Never carries the raw token or key in its message. */
export class InvalidGrantError extends OrchestraError {
  readonly code = "invalid_grant";
  constructor(message = "Grant token is invalid") {
    super(message);
  }
}

/** A grant token's signature verified but `exp` is at or before the verification instant (boundary exclusive — see `domain/grant.ts`'s `isExpired`). */
export class ExpiredGrantError extends OrchestraError {
  readonly code = "expired_grant";
  constructor(message = "Grant token has expired") {
    super(message);
  }
}

/** `GrantClaims` themselves violate an invariant (`maxCalls` not a positive safe integer, `exp` not after `iat`, ...) — raised by `Grant.create`, never by token verification (that's `InvalidGrantError`'s job). */
export class InvalidGrantClaimsError extends OrchestraError {
  readonly code = "invalid_grant_claims";
}
