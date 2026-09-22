/**
 * End-to-end proof of `BudgetedLlmClient` + `runSuite`'s `stopBefore` working
 * together across a real multi-scenario suite. No test here reads a real
 * ANTHROPIC_API_KEY or makes a real network call: `CountingLlmClient` is an
 * in-repo fake, never `AnthropicLlmClient`.
 *
 * Real behaviour this pins down (see `eval-run.ts`'s own header and
 * `cli.ts`'s Live doc-comment): `LlmClient.reason()` always runs inside a
 * Hono route handler (`SubmitIntent`/`AnswerClarification`), and this app's
 * single `app.onError` maps EVERY thrown error to a JSON response — so a
 * `LiveBudgetExhaustedError` thrown mid-scenario (a scenario's SECOND
 * `reason()` call, after its first already spent the last unit of budget)
 * never escapes `app.request()` as a thrown error. It surfaces as an
 * ordinary observed 500 on that one HTTP exchange instead: the scenario's
 * `outcome.error` stays `null`, its `observation` is non-null, and the
 * suite-level `stopBefore` check (consulted before the NEXT entry) is what
 * actually halts the run.
 */
import { describe, expect, it } from "vitest";
import { clarifyProposal } from "@apo/agent-orchestrator";
import type {
  AgentProposal,
  LlmClient,
  LlmReasoningRequest,
} from "@apo/agent-orchestrator";
import { BudgetedLlmClient } from "../llm/budgeted-llm-client.js";
import { corpusEntries, livePasses, runSuite } from "../eval-run.js";
import { parseScenario } from "../scenario.js";
import type { Scenario } from "../scenario.js";

class CountingLlmClient implements LlmClient {
  readonly name = "counting";
  calls = 0;

  reason(_input: LlmReasoningRequest): Promise<AgentProposal> {
    this.calls += 1;
    return Promise.resolve(clarifyProposal("which invoice did you mean?"));
  }
}

function benign(id: string, idempotencyKey: string): Scenario {
  return parseScenario(
    `${id}.json`,
    JSON.stringify({
      id,
      category: "benign",
      description: "e2e live-budget fixture",
      customerId: "cust_live_budget",
      text: "Pay $120 to acme for invoice 42",
      idempotencyKey,
      llm: { mode: "mock" },
      expect: {
        terminal: ["needs_clarification"],
        coreCalls: { min: 0, max: 0 },
      },
    }),
  );
}

function needsTwoCalls(id: string): Scenario {
  return parseScenario(
    `${id}.json`,
    JSON.stringify({
      id,
      category: "ambiguous",
      description: "e2e live-budget fixture: submit + an explicit clarify step",
      customerId: "cust_live_budget",
      text: "Pay $120 or $150 to acme for invoice 42",
      llm: { mode: "mock" },
      steps: [{ kind: "clarify", answer: "the $120 one" }],
      expect: {
        terminal: ["needs_clarification"],
        coreCalls: { min: 0, max: 0 },
      },
    }),
  );
}

describe("live budget ceiling, end to end", () => {
  it("stops the suite once the ceiling is hit, absorbing a mid-scenario exhaustion as an observed 500 rather than a crash", async () => {
    const s1 = benign("live-budget-s1", "idem-1");
    const s2 = needsTwoCalls("live-budget-s2");
    const s3 = benign("live-budget-s3", "idem-3");
    const inner = new CountingLlmClient();
    const budgeted = new BudgetedLlmClient(inner, 2);

    const suite = await runSuite(livePasses(corpusEntries([s1, s2, s3]), 1), {
      mode: "live",
      corpusDir: "e2e-fixture",
      llm: budgeted,
      stopBefore: () => budgeted.exhausted,
    });

    // s1 consumes call 1/2. s2's submit consumes call 2/2 (now exhausted);
    // its explicit clarify step's reason() call throws
    // LiveBudgetExhaustedError, which app.onError maps to a 500 — s2 still
    // completes with no thrown error. s3 is skipped: stopBefore trips before
    // it ever runs.
    expect(budgeted.calls).toBe(2);
    expect(budgeted.exhausted).toBe(true);
    expect(suite.outcomes.map((o) => o.scenario.id)).toEqual([
      "live-budget-s1",
      "live-budget-s2",
    ]);
    expect(suite.outcomes.every((o) => o.error === null)).toBe(true);
    expect(suite.outcomes.every((o) => o.observation !== null)).toBe(true);
    expect(suite.stoppedEarly).toBe(true);
    expect(suite.skipped).toBe(1);
    expect(suite.outcomes.length + suite.skipped).toBe(3);

    // The failed clarify exchange on s2 is visible as an observed 500, not
    // a hidden failure.
    const s2Outcome = suite.outcomes[1];
    const failedExchange = s2Outcome?.observation?.http.find(
      (x) => x.status === 500,
    );
    expect(failedExchange).toBeDefined();
    expect(failedExchange?.path).toContain("/clarify");
  });

  it("never stops early when the ceiling comfortably covers every entry", async () => {
    const s1 = benign("live-budget-comfortable-1", "idem-c1");
    const s2 = benign("live-budget-comfortable-2", "idem-c2");
    const inner = new CountingLlmClient();
    const budgeted = new BudgetedLlmClient(inner, 10);
    const suite = await runSuite(livePasses(corpusEntries([s1, s2]), 1), {
      mode: "live",
      corpusDir: "e2e-fixture",
      llm: budgeted,
      stopBefore: () => budgeted.exhausted,
    });
    expect(suite.stoppedEarly).toBe(false);
    expect(suite.skipped).toBe(0);
    expect(suite.outcomes).toHaveLength(2);
    expect(budgeted.calls).toBe(2);
  });
});
