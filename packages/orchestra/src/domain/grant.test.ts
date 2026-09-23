import { describe, expect, it } from "vitest";
import { Grant, type GrantProps } from "./grant.js";
import { InvalidGrantClaimsError } from "./errors.js";

const ISSUED_AT = new Date("2026-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date("2026-01-02T00:00:00.000Z");

function props(overrides?: Partial<GrantProps>): GrantProps {
  return {
    jti: "11111111-2222-4333-8444-555555555555",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    maxCalls: 20,
    usedCalls: 0,
    boundSessionId: null,
    ...overrides,
  };
}

describe("Grant.create invariants", () => {
  it("accepts valid props", () => {
    expect(() => Grant.create(props())).not.toThrow();
  });

  it("rejects maxCalls <= 0", () => {
    expect(() => Grant.create(props({ maxCalls: 0 }))).toThrow(
      InvalidGrantClaimsError,
    );
    expect(() => Grant.create(props({ maxCalls: -1 }))).toThrow(
      InvalidGrantClaimsError,
    );
  });

  it("rejects usedCalls > maxCalls", () => {
    expect(() => Grant.create(props({ maxCalls: 5, usedCalls: 6 }))).toThrow(
      InvalidGrantClaimsError,
    );
  });

  it("accepts usedCalls === maxCalls (exhausted, but a valid state)", () => {
    expect(() =>
      Grant.create(props({ maxCalls: 5, usedCalls: 5 })),
    ).not.toThrow();
  });

  it("rejects usedCalls < 0", () => {
    expect(() => Grant.create(props({ usedCalls: -1 }))).toThrow(
      InvalidGrantClaimsError,
    );
  });

  it("rejects expiresAt <= issuedAt", () => {
    expect(() => Grant.create(props({ expiresAt: ISSUED_AT }))).toThrow(
      InvalidGrantClaimsError,
    );
    expect(() =>
      Grant.create(props({ expiresAt: new Date(ISSUED_AT.getTime() - 1000) })),
    ).toThrow(InvalidGrantClaimsError);
  });

  it("rejects a non-UUID jti", () => {
    expect(() => Grant.create(props({ jti: "not-a-uuid" }))).toThrow(
      InvalidGrantClaimsError,
    );
  });
});

describe("Grant.remainingCalls", () => {
  it("computes maxCalls - usedCalls", () => {
    const grant = Grant.create(props({ maxCalls: 20, usedCalls: 7 }));
    expect(grant.remainingCalls).toBe(13);
  });

  it("is zero when exhausted", () => {
    const grant = Grant.create(props({ maxCalls: 5, usedCalls: 5 }));
    expect(grant.remainingCalls).toBe(0);
    expect(grant.isExhausted()).toBe(true);
  });
});

describe("Grant.isExpired — boundary exclusive", () => {
  it("is false strictly before expiresAt", () => {
    const grant = Grant.create(props());
    expect(grant.isExpired(new Date(EXPIRES_AT.getTime() - 1))).toBe(false);
  });

  it("is true exactly at expiresAt", () => {
    const grant = Grant.create(props());
    expect(grant.isExpired(EXPIRES_AT)).toBe(true);
  });

  it("is true strictly after expiresAt", () => {
    const grant = Grant.create(props());
    expect(grant.isExpired(new Date(EXPIRES_AT.getTime() + 1))).toBe(true);
  });
});

describe("Grant.isUsable", () => {
  it("is true when neither expired nor exhausted", () => {
    const grant = Grant.create(props({ maxCalls: 5, usedCalls: 4 }));
    expect(grant.isUsable(ISSUED_AT)).toBe(true);
  });

  it("is false once exhausted, even if not expired", () => {
    const grant = Grant.create(props({ maxCalls: 5, usedCalls: 5 }));
    expect(grant.isUsable(ISSUED_AT)).toBe(false);
  });

  it("is false once expired, even if not exhausted", () => {
    const grant = Grant.create(props({ maxCalls: 5, usedCalls: 0 }));
    expect(grant.isUsable(EXPIRES_AT)).toBe(false);
  });
});

describe("Grant.isBindableBy", () => {
  it("is true when unbound", () => {
    const grant = Grant.create(props({ boundSessionId: null }));
    expect(grant.isBindableBy("session-1")).toBe(true);
  });

  it("is true for the same already-bound session (idempotent)", () => {
    const grant = Grant.create(props({ boundSessionId: "session-1" }));
    expect(grant.isBindableBy("session-1")).toBe(true);
  });

  it("is false for a different session (the second-browser case)", () => {
    const grant = Grant.create(props({ boundSessionId: "session-1" }));
    expect(grant.isBindableBy("session-2")).toBe(false);
  });
});
