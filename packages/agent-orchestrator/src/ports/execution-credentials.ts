import { ExecutionInspectionError } from "../domain/errors.js";
import type { StoredIntent } from "./intent-repository.js";
/** Trusted immutable repository metadata; never part of an Intent or public submit. */
export const EXECUTION_PROFILES = [
  "demo_ok",
  "demo_transient",
  "demo_decline",
] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];
export interface ExecutionCredentials {
  resolve(stored: StoredIntent, configuredToken: string): string;
}
export function executionProfile(value: unknown): ExecutionProfile | null {
  if (value === null || value === undefined) return null;
  if (
    value === "demo_ok" ||
    value === "demo_transient" ||
    value === "demo_decline"
  )
    return value;
  throw new ExecutionInspectionError(
    409,
    "invalid_execution_profile",
    "Stored execution profile is not supported",
  );
}
