import { describe, expect, it } from "vitest";
import {
  isStartCall,
  RecordingAgentCoreClient,
} from "../core/recording-agent-core-client.js";
import { checkInvariants, violationsOf } from "../oracles/index.js";
import { runRateLimitInFlight } from "./scenarios.js";

// Corpus counterpart: src/corpus/limits-daily-rate-limit-01.json (same limit,
// but with a real sync between submits, so the rule sees the completed intent
// and the run is clean). This file pins the in-flight variant.
// CLI fixture src/cli-fixtures/violating/cli-fixture-violating.json depends on
// the same SUT bug (exactly one I8 violation); it flips together with this pair.
// Finding (README): the daily rate limit counts `completed` intents at
// proposal time, but an intent only becomes completed on a later GET sync, so
// N in-flight submits all pass a limit of N-1. Accepted as a known risk, see
// ADR-0019 (docs/adr/0019-daily-rate-limit-toctou-is-an-accepted-risk.md): a
// real fix belongs in agent-orchestrator (behind its own ADR), NOT in this
// package or in I8.
// The recorder reports the ledger run as completed, so a GET sync completes an intent.
const completingCore = () =>
  new RecordingAgentCoreClient({ runStatus: "completed" });

describe("limits: daily rate limit vs in-flight intents (TOCTOU)", () => {
  // Desired behaviour. Expected to fail until agent-orchestrator is fixed; when
  // it passes, vitest turns this red and the characterization below must go.
  it.fails(
    "must not let in-flight intents exceed the daily rate limit",
    async () => {
      const obs = await runRateLimitInFlight(completingCore());
      expect(violationsOf(checkInvariants(obs))).toEqual([]);
    },
  );

  // Characterization of today's behaviour: pinned exactly so a fix turns this
  // red and forces the flip of the pair.
  it("today: three in-flight intents all complete and I8 reports the breach", async () => {
    const obs = await runRateLimitInFlight(completingCore());
    expect(obs.intents).toHaveLength(3);
    expect(obs.intents.map((i) => i.finalView?.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(obs.coreCalls.filter(isStartCall)).toHaveLength(3);
    expect(
      violationsOf(checkInvariants(obs)).map((v) => ({
        invariant: v.invariant,
        message: v.message,
      })),
    ).toEqual([
      {
        invariant: "I8",
        message: "3 completed intents exceed the daily rate limit 2",
      },
    ]);
  });
});
