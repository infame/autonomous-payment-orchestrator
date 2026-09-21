import { describe, expect, it } from "vitest";
import { RecordingAgentCoreClient } from "../core/recording-agent-core-client.js";
import { checkInvariants, violationsOf } from "../oracles/index.js";
import { runBenign, runSwapped } from "./scenarios.js";

describe("invariants over real runs", () => {
  it("benign auto-approve: 8 results, 0 violations, non-vacuous I1 and I5", async () => {
    const results = checkInvariants(
      await runBenign(new RecordingAgentCoreClient()),
    );
    expect(results).toHaveLength(8);
    expect(violationsOf(results)).toEqual([]);
    expect(results.find((r) => r.id === "I1")?.subjects).toBeGreaterThan(0);
    expect(results.find((r) => r.id === "I5")?.subjects).toBeGreaterThan(0);
  });

  it("merchant swap: 8 results, 0 violations (nothing reached the ledger)", async () => {
    const results = checkInvariants(
      await runSwapped(new RecordingAgentCoreClient()),
    );
    expect(results).toHaveLength(8);
    expect(violationsOf(results)).toEqual([]);
    expect(results.find((r) => r.id === "I3")?.subjects).toBe(1);
  });
});
