import { describe, expect, it } from "vitest";
import {
  isPolicyReasonCode,
  POLICY_REASON_CODES,
  type PolicyReasonCode,
} from "./verdict.js";

// `satisfies Record<PolicyReasonCode, true>` is the compile-time half of the
// guard: adding or removing a union member breaks typecheck here. Do not
// simplify it away; the runtime assertions below are the other half.
const EXPECTED = {
  currency_not_allowed: true,
  amount_not_grounded: true,
  merchant_not_grounded: true,
  hard_limit_exceeded: true,
  daily_rate_limit_exceeded: true,
  above_auto_approve_threshold: true,
} satisfies Record<PolicyReasonCode, true>;

describe("POLICY_REASON_CODES", () => {
  it("matches the PolicyReasonCode union exactly", () => {
    expect([...POLICY_REASON_CODES].sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  it("has no duplicates", () => {
    expect(new Set(POLICY_REASON_CODES).size).toBe(POLICY_REASON_CODES.length);
  });

  it("isPolicyReasonCode accepts known codes and rejects others", () => {
    expect(isPolicyReasonCode("merchant_not_grounded")).toBe(true);
    expect(isPolicyReasonCode("nope")).toBe(false);
  });
});
