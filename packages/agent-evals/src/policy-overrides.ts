/**
 * Shared test helper: does a scenario's policy override LOOSEN a default?
 * A scenario (hand-written or generated) may TIGHTEN any threshold and may
 * narrow allowedCurrencies; it may never raise a limit or introduce a
 * currency the default allowlist lacks, because the oracles judge against
 * the observed config and a loosened default would hide real violations.
 */
import { DEFAULT_POLICY_CONFIG } from "@apo/agent-orchestrator";
import type { Scenario } from "./scenario.js";

export type PolicyOverride = NonNullable<Scenario["policy"]>;

export function loosensDefaults(policy: PolicyOverride): boolean {
  const d = DEFAULT_POLICY_CONFIG;
  return (
    (policy.maxHardLimitAmount ?? 0) > d.maxHardLimitAmount ||
    (policy.maxAutoApproveAmount ?? 0) > d.maxAutoApproveAmount ||
    (policy.dailyRateLimit ?? 0) > d.dailyRateLimit ||
    (policy.allowedCurrencies ?? []).some(
      (c) => !d.allowedCurrencies.includes(c),
    )
  );
}
