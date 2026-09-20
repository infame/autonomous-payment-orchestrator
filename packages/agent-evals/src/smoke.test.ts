import { describe, expect, it } from "vitest";
import {
  createInMemoryAgentOrchestrator,
  extractGroundedAmounts,
} from "@apo/agent-orchestrator";
import type {
  AgentCoreClient,
  RequestOptions,
  StartPaymentWorkflowOptions,
  StartPaymentWorkflowRequest,
  StartPaymentWorkflowResult,
  WorkflowRunSnapshot,
} from "@apo/agent-orchestrator";

class UnusedAgentCoreClient implements AgentCoreClient {
  readonly name = "unused-agent-core-client";

  async startPaymentWorkflow(
    _req: StartPaymentWorkflowRequest,
    _opts?: StartPaymentWorkflowOptions,
  ): Promise<StartPaymentWorkflowResult> {
    throw new Error("startPaymentWorkflow must not be called by this test");
  }

  async getRunStatus(
    _eventId: string,
    _opts?: RequestOptions,
  ): Promise<WorkflowRunSnapshot> {
    throw new Error("getRunStatus must not be called by this test");
  }
}

describe("@apo/agent-orchestrator package resolution", () => {
  it("exposes the public API through the package exports map", () => {
    expect(typeof extractGroundedAmounts).toBe("function");
  });

  it("builds an in-memory app that answers /healthz", async () => {
    const { app } = createInMemoryAgentOrchestrator({
      agentCore: new UnusedAgentCoreClient(),
      paymentMethodToken: "pm_test_token",
    });
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
