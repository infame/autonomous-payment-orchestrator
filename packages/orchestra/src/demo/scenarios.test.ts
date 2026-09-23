import { afterEach, describe, expect, it } from "vitest";
import { AgentOrchestratorClient, DurableLedgerClient } from "./client.js";
import { runScenarioA, runScenarioB, runScenarioC } from "./scenarios.js";
import {
  startScriptedServer,
  type ScriptedRequest,
  type ScriptedRoute,
  type ScriptedServer,
} from "../test-support/scripted-http-server.js";

/**
 * Drives each scenario against an in-process, real-socket fake stack (two
 * `startScriptedServer`s: one standing in for `agent-orchestrator`, one for
 * `durable-ledger`) — no docker, no network beyond localhost. Each fake is
 * scripted with the EXACT response sequence the real stack would produce for
 * that scenario's known, fixed inputs (see `scenarios.ts`'s own text
 * constants) — this proves `scenarios.ts`'s own step/assertion logic and
 * response parsing, not agent-orchestrator's policy engine (that's proven by
 * agent-orchestrator's and agent-evals' own test suites).
 */

const openServers: ScriptedServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()));
});

async function startFakes(
  orchestratorRoutes: ScriptedRoute[],
  ledgerRoutes: ScriptedRoute[],
): Promise<{
  orchestrator: AgentOrchestratorClient;
  ledger: DurableLedgerClient;
  ledgerRequests: ScriptedRequest[];
}> {
  const orchestratorServer = await startScriptedServer(orchestratorRoutes);
  const ledgerServer = await startScriptedServer(ledgerRoutes);
  openServers.push(orchestratorServer, ledgerServer);
  return {
    orchestrator: new AgentOrchestratorClient({
      baseUrl: orchestratorServer.baseUrl,
      timeoutMs: 2000,
    }),
    ledger: new DurableLedgerClient({
      baseUrl: ledgerServer.baseUrl,
      timeoutMs: 2000,
      serviceSecret: "s".repeat(32),
    }),
    ledgerRequests: ledgerServer.requests,
  };
}

function intentView(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "intent-1",
    customerId: "demo-customer",
    text: "irrelevant for this fake",
    status: "received",
    proposal: null,
    policyVerdict: null,
    durableLedgerEventId: null,
    clarificationAnswer: null,
    ...overrides,
  };
}

function balanceRoute(account: string, amount: number): ScriptedRoute {
  return {
    method: "GET",
    path: new RegExp(
      `^/ledger/accounts/${encodeURIComponent(account).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/balance$`,
    ),
    respond: {
      status: 200,
      body: { account, currency: "USD", balance: { amount, currency: "USD" } },
    },
  };
}

const PAYMENT_PROPOSAL = {
  kind: "propose_payment",
  amount: 120_000,
  currency: "USD",
  merchantId: "vendor",
  reasoning: "Selected the min candidate amount found in the intent text.",
};
const NEEDS_APPROVAL_VERDICT = {
  decision: "needs_approval",
  reason: "above_auto_approve_threshold",
  detail: "Amount is at or above the auto-approve threshold",
};

describe("runScenarioA", () => {
  it("reaches completed and asserts two balanced ledger deltas", async () => {
    const orchestratorRoutes: ScriptedRoute[] = [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: {
          status: 201,
          body: {
            intent: intentView({
              id: "intent-a-1",
              status: "needs_clarification",
            }),
            verdict: null,
          },
        },
      },
      {
        method: "POST",
        path: /^\/intents\/intent-a-1\/clarify$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-1",
              status: "needs_approval",
              proposal: PAYMENT_PROPOSAL,
              policyVerdict: NEEDS_APPROVAL_VERDICT,
              clarificationAnswer: "Use the invoice header amount, $1,200.00.",
            }),
          },
        },
      },
      {
        method: "POST",
        path: /^\/intents\/intent-a-1\/approve$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-1",
              status: "executing",
              proposal: PAYMENT_PROPOSAL,
              policyVerdict: NEEDS_APPROVAL_VERDICT,
              durableLedgerEventId: "evt-a-1",
            }),
          },
        },
      },
      {
        method: "GET",
        path: /^\/intents\/intent-a-1$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-1",
              status: "executing",
              proposal: PAYMENT_PROPOSAL,
              durableLedgerEventId: "evt-a-1",
            }),
          },
        },
      },
      {
        method: "GET",
        path: /^\/intents\/intent-a-1$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-1",
              status: "completed",
              proposal: PAYMENT_PROPOSAL,
              durableLedgerEventId: "evt-a-1",
            }),
          },
        },
      },
    ];
    const ledgerRoutes: ScriptedRoute[] = [
      balanceRoute("merchant:vendor", 0),
      balanceRoute("acquirer_clearing", 0),
      balanceRoute("merchant:vendor", 120_000),
      balanceRoute("acquirer_clearing", -120_000),
    ];

    const clients = await startFakes(orchestratorRoutes, ledgerRoutes);
    const result = await runScenarioA({
      customerId: "demo-customer-a",
      clients,
      pollIntervalMs: 1,
      pollDeadlineMs: 5000,
    });

    expect(result.failure).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.beats.length).toBeGreaterThan(0);
    expect(clients.ledgerRequests.length).toBeGreaterThan(0);
    for (const request of clients.ledgerRequests) {
      expect(request.headers["x-service-secret"]).toBe("s".repeat(32));
    }
  });

  it("fails the scenario (not the harness) when the terminal status is wrong", async () => {
    const orchestratorRoutes: ScriptedRoute[] = [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: {
          status: 201,
          body: {
            intent: intentView({
              id: "intent-a-2",
              status: "needs_clarification",
            }),
            verdict: null,
          },
        },
      },
      {
        method: "POST",
        path: /^\/intents\/intent-a-2\/clarify$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-2",
              status: "needs_approval",
              proposal: PAYMENT_PROPOSAL,
              policyVerdict: NEEDS_APPROVAL_VERDICT,
            }),
          },
        },
      },
      {
        method: "POST",
        path: /^\/intents\/intent-a-2\/approve$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-2",
              status: "executing",
              proposal: PAYMENT_PROPOSAL,
              durableLedgerEventId: "evt-a-2",
            }),
          },
        },
      },
      {
        method: "GET",
        path: /^\/intents\/intent-a-2$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-a-2",
              status: "needs_review",
              proposal: PAYMENT_PROPOSAL,
              durableLedgerEventId: "evt-a-2",
            }),
          },
        },
      },
    ];
    const ledgerRoutes: ScriptedRoute[] = [
      balanceRoute("merchant:vendor", 0),
      balanceRoute("acquirer_clearing", 0),
    ];

    const clients = await startFakes(orchestratorRoutes, ledgerRoutes);
    const result = await runScenarioA({
      customerId: "demo-customer-a2",
      clients,
      pollIntervalMs: 1,
      pollDeadlineMs: 5000,
    });

    expect(result.passed).toBe(false);
    expect(result.failure).toContain("needs_review");
  });
});

describe("runScenarioB", () => {
  it("reaches rejected with zero core calls and unchanged balances", async () => {
    const orchestratorRoutes: ScriptedRoute[] = [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: {
          status: 201,
          body: {
            intent: intentView({
              id: "intent-b-1",
              status: "needs_clarification",
            }),
            verdict: null,
          },
        },
      },
      {
        method: "POST",
        path: /^\/intents\/intent-b-1\/clarify$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-b-1",
              status: "needs_approval",
              proposal: PAYMENT_PROPOSAL,
              policyVerdict: NEEDS_APPROVAL_VERDICT,
            }),
          },
        },
      },
      {
        method: "POST",
        path: /^\/intents\/intent-b-1\/reject$/,
        respond: {
          status: 200,
          body: {
            intent: intentView({
              id: "intent-b-1",
              status: "rejected",
              proposal: PAYMENT_PROPOSAL,
              policyVerdict: NEEDS_APPROVAL_VERDICT,
            }),
          },
        },
      },
    ];
    const ledgerRoutes: ScriptedRoute[] = [
      balanceRoute("merchant:vendor", 500),
      balanceRoute("acquirer_clearing", -500),
      balanceRoute("merchant:vendor", 500),
      balanceRoute("acquirer_clearing", -500),
    ];

    const clients = await startFakes(orchestratorRoutes, ledgerRoutes);
    const result = await runScenarioB({
      customerId: "demo-customer-b",
      clients,
    });

    expect(result.failure).toBeUndefined();
    expect(result.passed).toBe(true);
    // No "approve" route is scripted above at all — had the scenario ever
    // called it, the fake's unscripted-404 fallback would have thrown a
    // DemoClientError and failed this test outright. Zero core calls is
    // therefore proven by construction, not just by `durableLedgerEventId`.
  });
});

describe("runScenarioC", () => {
  it("reaches rejected with zero core calls and unchanged ledger", async () => {
    const orchestratorRoutes: ScriptedRoute[] = [
      {
        method: "POST",
        path: /^\/intents$/,
        respond: {
          status: 201,
          body: {
            intent: intentView({
              id: "intent-c-1",
              status: "rejected",
              policyVerdict: {
                decision: "reject",
                reason: "amount_not_grounded",
                detail: "Proposed amount does not appear in the intent text",
              },
            }),
            verdict: {
              decision: "reject",
              reason: "amount_not_grounded",
              detail: "Proposed amount does not appear in the intent text",
            },
          },
        },
      },
    ];
    const ledgerRoutes: ScriptedRoute[] = [
      balanceRoute("merchant:vendor", 0),
      balanceRoute("merchant:vendor", 0),
    ];

    const clients = await startFakes(orchestratorRoutes, ledgerRoutes);
    const result = await runScenarioC({
      customerId: "demo-customer-c",
      clients,
    });

    expect(result.failure).toBeUndefined();
    expect(result.passed).toBe(true);
  });
});
