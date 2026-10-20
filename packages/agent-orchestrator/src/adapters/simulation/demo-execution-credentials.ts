import type { ExecutionCredentials } from "../../ports/execution-credentials.js";
import type { StoredIntent } from "../../ports/intent-repository.js";
import { executionProfile } from "../../ports/execution-credentials.js";
import { ExecutionInspectionError } from "../../domain/errors.js";
export class DemoExecutionCredentials implements ExecutionCredentials {
  constructor(private readonly enabled: boolean) {}
  resolve(stored: StoredIntent, configuredToken: string): string {
    const profile = executionProfile(stored.executionProfile);
    if (profile === null) return configuredToken;
    if (!this.enabled)
      throw new ExecutionInspectionError(
        409,
        "demo_disabled",
        "The stored simulation profile is unavailable in this service mode",
      );
    const token =
      profile === "demo_transient"
        ? "sim.fail_then_succeed.1"
        : profile === "demo_decline"
          ? "sim.decline.insufficient_funds"
          : "sim.ok";
    return `${token}.${stored.intent.id}`;
  }
}
