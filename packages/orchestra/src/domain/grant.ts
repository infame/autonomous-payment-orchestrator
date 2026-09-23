/**
 * `Grant` — a pure value object over a live-grant row's invariants. Zero I/O,
 * zero imports beyond this package's own errors: `ports/grant-store.ts` and
 * `adapters/persistence/drizzle/*` are the only places that ever read/write
 * a grant from Postgres; this file only ever validates and projects.
 */
import { InvalidGrantClaimsError } from "./errors.js";

export interface GrantProps {
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly maxCalls: number;
  readonly usedCalls: number;
  readonly boundSessionId: string | null;
}

const JTI_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Grant {
  private constructor(private readonly props: GrantProps) {}

  /**
   * Validates and constructs a `Grant`. Every invariant here mirrors a
   * `CHECK` constraint on `orchestra.live_grants`
   * (`adapters/persistence/drizzle/schema.ts`) — a second line of defense,
   * not the primary one; the database is the source of truth once a row
   * exists, this is what stops an invalid one from ever being written or
   * from being fabricated in-process.
   */
  static create(props: GrantProps): Grant {
    if (!JTI_PATTERN.test(props.jti)) {
      throw new InvalidGrantClaimsError(
        `jti must be a UUID, got ${JSON.stringify(props.jti)}`,
      );
    }
    if (!Number.isSafeInteger(props.maxCalls) || props.maxCalls <= 0) {
      throw new InvalidGrantClaimsError(
        `maxCalls must be a positive safe integer, got ${String(props.maxCalls)}`,
      );
    }
    if (!Number.isSafeInteger(props.usedCalls) || props.usedCalls < 0) {
      throw new InvalidGrantClaimsError(
        `usedCalls must be a non-negative safe integer, got ${String(props.usedCalls)}`,
      );
    }
    if (props.usedCalls > props.maxCalls) {
      throw new InvalidGrantClaimsError(
        `usedCalls (${String(props.usedCalls)}) must not exceed maxCalls (${String(props.maxCalls)})`,
      );
    }
    if (props.expiresAt.getTime() <= props.issuedAt.getTime()) {
      throw new InvalidGrantClaimsError("expiresAt must be after issuedAt");
    }
    return new Grant(props);
  }

  get jti(): string {
    return this.props.jti;
  }

  get issuedAt(): Date {
    return this.props.issuedAt;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get maxCalls(): number {
    return this.props.maxCalls;
  }

  get usedCalls(): number {
    return this.props.usedCalls;
  }

  get boundSessionId(): string | null {
    return this.props.boundSessionId;
  }

  get remainingCalls(): number {
    return this.props.maxCalls - this.props.usedCalls;
  }

  /**
   * Expiry is checked with a STRICT `<=` (boundary exclusive of `now`) — a
   * grant whose `expiresAt` is exactly `now` is already expired. Matches the
   * atomic claim SQL's `expires_at > now()` predicate
   * (`ports/grant-store.ts`) exactly: that predicate is false when
   * `expires_at === now()`, so this method and the real claim query can
   * never disagree at the boundary.
   */
  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  isExhausted(): boolean {
    return this.props.usedCalls >= this.props.maxCalls;
  }

  isUsable(now: Date): boolean {
    return !this.isExpired(now) && !this.isExhausted();
  }

  /** `true` when no session has opened this grant's link yet, or when `sessionId` is the one that already did (idempotent re-check for the same caller). `false` for every other session — the "second browser" case. */
  isBindableBy(sessionId: string): boolean {
    return (
      this.props.boundSessionId === null ||
      this.props.boundSessionId === sessionId
    );
  }
}
