import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signGrant, verifyGrant, type GrantClaims } from "./token.js";
import { ExpiredGrantError, InvalidGrantError } from "../domain/errors.js";

const KEY = "a".repeat(32);
const OTHER_KEY = "b".repeat(32);
const NOW = new Date("2026-01-01T00:00:00.000Z");

function claims(overrides?: Partial<GrantClaims>): GrantClaims {
  return {
    jti: "11111111-2222-4333-8444-555555555555",
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    maxCalls: 20,
    ...overrides,
  };
}

describe("signGrant / verifyGrant", () => {
  it("round-trips valid claims", () => {
    const token = signGrant(claims(), KEY);
    const verified = verifyGrant(token, KEY, NOW);
    expect(verified).toEqual(claims());
  });

  it("throws InvalidGrantError when the payload is tampered with", () => {
    const token = signGrant(claims(), KEY);
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify(claims({ maxCalls: 999_999 })),
      "utf8",
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${signature}`;
    expect(() => verifyGrant(tampered, KEY, NOW)).toThrow(InvalidGrantError);
  });

  it("throws InvalidGrantError when the signature is tampered with", () => {
    const token = signGrant(claims(), KEY);
    const [payload] = token.split(".");
    const tampered = `${payload}.${"A".repeat(43)}`;
    expect(() => verifyGrant(tampered, KEY, NOW)).toThrow(InvalidGrantError);
  });

  it("throws InvalidGrantError under the wrong key", () => {
    const token = signGrant(claims(), KEY);
    expect(() => verifyGrant(token, OTHER_KEY, NOW)).toThrow(InvalidGrantError);
  });

  it("throws InvalidGrantError for a malformed token", () => {
    expect(() => verifyGrant("not-a-token", KEY, NOW)).toThrow(
      InvalidGrantError,
    );
    expect(() => verifyGrant("a.b.c", KEY, NOW)).toThrow(InvalidGrantError);
    expect(() => verifyGrant("", KEY, NOW)).toThrow(InvalidGrantError);
    expect(() => verifyGrant(".", KEY, NOW)).toThrow(InvalidGrantError);
  });

  it("throws InvalidGrantError when a validly-signed payload isn't valid GrantClaims JSON", () => {
    // Sign a bogus payload for real (with the real key), so this exercises
    // "signature verifies but shape is wrong" specifically, not just a
    // signature mismatch.
    const payloadB64 = Buffer.from(
      JSON.stringify({ not: "claims" }),
      "utf8",
    ).toString("base64url");
    const signatureB64 = createHmac("sha256", KEY)
      .update(payloadB64)
      .digest("base64url");
    const validlySignedBogusToken = `${payloadB64}.${signatureB64}`;
    expect(() => verifyGrant(validlySignedBogusToken, KEY, NOW)).toThrow(
      InvalidGrantError,
    );
  });

  it("throws ExpiredGrantError for an expired, otherwise-valid token, boundary inclusive", () => {
    const expiresAt = Math.floor(NOW.getTime() / 1000) + 100;
    const token = signGrant(claims({ exp: expiresAt }), KEY);
    // exp === now (in seconds) counts as already expired.
    const atBoundary = new Date(expiresAt * 1000);
    expect(() => verifyGrant(token, KEY, atBoundary)).toThrow(
      ExpiredGrantError,
    );
    const afterExpiry = new Date((expiresAt + 1) * 1000);
    expect(() => verifyGrant(token, KEY, afterExpiry)).toThrow(
      ExpiredGrantError,
    );
    const beforeExpiry = new Date((expiresAt - 1) * 1000);
    expect(() => verifyGrant(token, KEY, beforeExpiry)).not.toThrow();
  });

  it("verifyGrant is total on garbage input — never throws anything but the two documented error types", () => {
    const garbageInputs = [
      "",
      ".",
      "..",
      "a",
      "a.b",
      "a.b.c",
      "🙂.🙂",
      Buffer.from("null").toString("base64url") + ".AAAA",
      Buffer.from("[]").toString("base64url") + ".AAAA",
      Buffer.from('"a string"').toString("base64url") + ".AAAA",
    ];
    for (const input of garbageInputs) {
      let caught: unknown;
      try {
        verifyGrant(input, KEY, NOW);
      } catch (err) {
        caught = err;
      }
      expect(
        caught instanceof InvalidGrantError ||
          caught instanceof ExpiredGrantError,
        `expected InvalidGrantError or ExpiredGrantError for input ${JSON.stringify(input)}, got ${String(caught)}`,
      ).toBe(true);
    }
  });
});
