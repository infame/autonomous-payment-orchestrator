/**
 * Self-contained grant token: HMAC-SHA256 sign/verify over a small claims
 * object, `node:crypto` only — no JWT dependency, no new package. Wire
 * format: `${base64url(JSON.stringify(claims))}.${base64url(hmac)}`.
 *
 * Deliberately NOT a JWT: a JWT's header would let a caller choose `alg`
 * (including `none`, a well-known JWT footgun) or smuggle unexpected claims
 * through a generic decoder. This format has exactly one algorithm, decided
 * at the call site, not read off the wire.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidGrantError, ExpiredGrantError } from "../domain/errors.js";

export interface GrantClaims {
  /** UUID — the `orchestra.live_grants` row key this token authorizes. */
  readonly jti: string;
  /** Unix seconds. */
  readonly exp: number;
  /** Positive safe integer — informational only on the token; the real cap enforced at claim time is the database row's `max_calls` (`ports/grant-store.ts`). Carried here so `GET /grant/:token` can render it without a DB round trip. */
  readonly maxCalls: number;
}

const JTI_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total: never throws. Returns `null` for anything that isn't a well-formed `GrantClaims` shape. Used only internally by `verifyGrant`, after the signature has already been checked — never trust an unverified payload's shape as a substitute for the signature check. */
function parseClaims(value: unknown): GrantClaims | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { jti, exp, maxCalls } = value;
  if (
    typeof jti !== "string" ||
    !JTI_PATTERN.test(jti) ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    exp <= 0 ||
    typeof maxCalls !== "number" ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls <= 0
  ) {
    return null;
  }
  return { jti, exp, maxCalls };
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function hmacFor(payloadB64: string, key: string): Buffer {
  return createHmac("sha256", key).update(payloadB64).digest();
}

/** Signs `claims` with `key`, producing the wire token. `key` must be `GRANT_SIGNING_KEY` — never `ADMIN_SECRET` (two different secrets, two different exposure surfaces; see `config.ts`). */
export function signGrant(claims: GrantClaims, key: string): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signatureB64 = hmacFor(payloadB64, key).toString("base64url");
  return `${payloadB64}.${signatureB64}`;
}

/**
 * Verifies `token` against `key` at instant `now`. Throws `InvalidGrantError`
 * for anything structurally or cryptographically wrong (malformed token,
 * bad base64, signature mismatch, unparseable/invalid claims shape) and
 * `ExpiredGrantError` ONLY when the signature is valid but `exp` is at or
 * before `now` — that distinction matters at the HTTP boundary (both still
 * map to a rejection, but an expired-vs-tampered token is a genuinely
 * different fact about a genuinely genuine token).
 *
 * The signature is checked with `timingSafeEqual`, never `===` — a
 * short-circuiting string compare on a value derived from a secret is
 * exactly the class of bug `node:crypto`'s own docs warn `timingSafeEqual`
 * exists to close.
 */
export function verifyGrant(
  token: string,
  key: string,
  now: Date,
): GrantClaims {
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new InvalidGrantError();
  }
  const [payloadB64, signatureB64] = parts;
  if (
    payloadB64 === undefined ||
    payloadB64 === "" ||
    signatureB64 === undefined ||
    signatureB64 === ""
  ) {
    throw new InvalidGrantError();
  }

  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signatureB64, "base64url");
  } catch {
    throw new InvalidGrantError();
  }
  const expectedSignature = hmacFor(payloadB64, key);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new InvalidGrantError();
  }

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    throw new InvalidGrantError();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new InvalidGrantError();
  }
  const claims = parseClaims(payload);
  if (claims === null) {
    throw new InvalidGrantError();
  }

  // Expiry is checked AFTER signature verification (a forged/expired token
  // must never distinguish itself from a forged/unexpired one via a
  // different error), and boundary-exclusive — `exp === now` is already
  // expired, matching `domain/grant.ts`'s `Grant.isExpired`.
  if (claims.exp * 1000 <= now.getTime()) {
    throw new ExpiredGrantError();
  }

  return claims;
}
