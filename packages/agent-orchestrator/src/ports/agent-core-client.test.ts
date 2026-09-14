import { describe, expect, it } from "vitest";
import { paymentProposal } from "../domain/agent-proposal.js";
import {
  AgentCoreBadRequestError,
  AgentCoreClientError,
  AgentCoreMalformedResponseError,
  AgentCoreNetworkError,
  AgentCoreRequestCanceledError,
  AgentCoreRunNotFoundError,
  AgentCoreTimeoutError,
  AgentCoreUnavailableError,
  AgentCoreUnexpectedResponseError,
  isTerminalRunStatus,
  paymentWorkflowRequestFor,
  TERMINAL_WORKFLOW_RUN_STATUSES,
} from "./agent-core-client.js";
import type { WorkflowRunStatus } from "./agent-core-client.js";
import { OrchestratorError } from "../domain/errors.js";

const REASONING_WITH_SECRET =
  "Invoice #445291 requests 4200 minor units for merchant m_1, verified twice.";

function proposal(overrides?: Partial<Parameters<typeof paymentProposal>[0]>) {
  return paymentProposal({
    amount: 4200,
    currency: "USD",
    merchantId: "m_1",
    reasoning: REASONING_WITH_SECRET,
    ...overrides,
  });
}

describe("paymentWorkflowRequestFor", () => {
  it("maps exactly the four wire fields, nothing more", () => {
    const result = paymentWorkflowRequestFor({
      proposal: proposal(),
      paymentMethodToken: "tok_visa",
    });
    expect(Object.keys(result).sort()).toEqual(
      ["amount", "currency", "merchantId", "paymentMethodToken"].sort(),
    );
    expect(result).toEqual({
      amount: 4200,
      currency: "USD",
      paymentMethodToken: "tok_visa",
      merchantId: "m_1",
    });
  });

  it("never reads proposal.reasoning — the reasoning's content never leaks into the wire body", () => {
    const result = paymentWorkflowRequestFor({
      proposal: proposal(),
      paymentMethodToken: "tok_visa",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Invoice #445291");
    expect(serialized).not.toContain("445291");
  });

  it("rejects a blank token before any I/O", () => {
    expect(() =>
      paymentWorkflowRequestFor({
        proposal: proposal(),
        paymentMethodToken: "   ",
      }),
    ).toThrow(AgentCoreBadRequestError);
  });

  it("rejects an empty token before any I/O", () => {
    expect(() =>
      paymentWorkflowRequestFor({
        proposal: proposal(),
        paymentMethodToken: "",
      }),
    ).toThrow(AgentCoreBadRequestError);
  });

  it("passes a sim.fail_then_succeed.2-shaped token through byte-for-byte, keeping the demo's simulated-503-then-retry scenario reachable", () => {
    const token = "sim.fail_then_succeed.2";
    const result = paymentWorkflowRequestFor({
      proposal: proposal(),
      paymentMethodToken: token,
    });
    expect(result.paymentMethodToken).toBe(token);
  });
});

describe("isTerminalRunStatus / TERMINAL_WORKFLOW_RUN_STATUSES", () => {
  const expectations: ReadonlyArray<[WorkflowRunStatus, boolean]> = [
    ["queued", false],
    ["running", false],
    ["completed", true],
    ["failed", true],
    ["cancelled", true],
  ];

  it.each(expectations)(
    "isTerminalRunStatus(%s) === %s",
    (status, expected) => {
      expect(isTerminalRunStatus(status)).toBe(expected);
    },
  );

  it("TERMINAL_WORKFLOW_RUN_STATUSES is exactly {completed, failed, cancelled}", () => {
    expect(new Set(TERMINAL_WORKFLOW_RUN_STATUSES)).toEqual(
      new Set(["completed", "failed", "cancelled"]),
    );
  });
});

describe("AgentCoreClientError subclasses", () => {
  const ctx = {
    operation: "start_payment_workflow" as const,
    status: undefined,
    ledgerCode: undefined,
  };

  const rows: ReadonlyArray<{
    readonly build: () => AgentCoreClientError;
    readonly name: string;
    readonly code: string;
    readonly retryable: boolean;
  }> = [
    {
      build: () => new AgentCoreNetworkError("x", ctx),
      name: "AgentCoreNetworkError",
      code: "agent_core_network_error",
      retryable: true,
    },
    {
      build: () => new AgentCoreTimeoutError("x", ctx, 1000),
      name: "AgentCoreTimeoutError",
      code: "agent_core_timeout",
      retryable: true,
    },
    {
      build: () => new AgentCoreRequestCanceledError("x", ctx),
      name: "AgentCoreRequestCanceledError",
      code: "agent_core_canceled",
      retryable: false,
    },
    {
      build: () => new AgentCoreBadRequestError("x", ctx),
      name: "AgentCoreBadRequestError",
      code: "agent_core_bad_request",
      retryable: false,
    },
    {
      build: () => new AgentCoreRunNotFoundError("x", ctx),
      name: "AgentCoreRunNotFoundError",
      code: "agent_core_run_not_found",
      retryable: false,
    },
    {
      build: () => new AgentCoreUnavailableError("x", ctx),
      name: "AgentCoreUnavailableError",
      code: "agent_core_unavailable",
      retryable: true,
    },
    {
      build: () => new AgentCoreMalformedResponseError("x", ctx),
      name: "AgentCoreMalformedResponseError",
      code: "agent_core_malformed_response",
      retryable: false,
    },
  ];

  it.each(rows)("$name: code/retryable/name/instanceof", (row) => {
    const err = row.build();
    expect(err.code).toBe(row.code);
    expect(err.retryable).toBe(row.retryable);
    expect(err.name).toBe(row.name);
    expect(err).toBeInstanceOf(AgentCoreClientError);
    expect(err).not.toBeInstanceOf(OrchestratorError);
  });

  const unexpectedRows: ReadonlyArray<[number, boolean]> = [
    [500, true],
    [502, true],
    [429, true],
    [408, true],
    [404, false],
    [418, false],
  ];

  it.each(unexpectedRows)(
    "AgentCoreUnexpectedResponseError status %i -> retryable %s",
    (status, retryable) => {
      const err = new AgentCoreUnexpectedResponseError("x", { ...ctx, status });
      expect(err.retryable).toBe(retryable);
      expect(err.name).toBe("AgentCoreUnexpectedResponseError");
      expect(err).toBeInstanceOf(AgentCoreClientError);
      expect(err).not.toBeInstanceOf(OrchestratorError);
    },
  );
});
