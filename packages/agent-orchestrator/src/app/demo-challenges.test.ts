import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { createInMemoryAgentOrchestrator } from "../composition-root.js";
import { FakeAgentCoreClient } from "../adapters/memory/fake-agent-core-client.js";
import { InMemoryIntentRepository } from "../adapters/memory/in-memory-intent-repository.js";
import { DemoExecutionCredentials } from "../adapters/simulation/demo-execution-credentials.js";
import { Intent } from "../domain/intent.js";
import { ApproveIntent } from "./approve-intent.js";
import { AutoApproveIntent } from "./auto-approve-intent.js";

async function challenge(
  app: ReturnType<typeof createInMemoryAgentOrchestrator>["app"],
  scenario: string,
  customerId = "visitor",
) {
  return app.request("/demo/challenges", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-customer-id": customerId,
    },
    body: JSON.stringify({ scenario }),
  });
}
describe("isolated fixed demo challenges", () => {
  it("produces an actual inflated proposal then rejects it through real policy", async () => {
    const core = new FakeAgentCoreClient();
    const { app, intents } = createInMemoryAgentOrchestrator({
      agentCore: core,
      paymentMethodToken: "configured",
      demoChallengesEnabled: true,
    });
    const response = await challenge(app, "inflated_amount");
    const body = (await response.json()) as {
      intent: {
        id: string;
        status: string;
        proposal: { amount: number };
        policyVerdict: { reason: string };
      };
    };
    expect(response.status).toBe(201);
    expect(body.intent.proposal.amount).toBe(500000);
    expect(body.intent.status).toBe("rejected");
    expect(body.intent.policyVerdict.reason).toBe("amount_not_grounded");
    expect(core.calls).toHaveLength(0);
    expect((await intents.findById(body.intent.id))?.executionProfile).toBe(
      "demo_ok",
    );
  });
  it("starts the real $600 decline proposal through the existing approval path and isolated profile", async () => {
    const core = new FakeAgentCoreClient();
    const { app, intents } = createInMemoryAgentOrchestrator({
      agentCore: core,
      paymentMethodToken: "configured",
      demoChallengesEnabled: true,
    });
    const response = await challenge(app, "permanent_decline");
    const body = (await response.json()) as {
      intent: {
        id: string;
        text: string;
        status: string;
        proposal: { amount: number };
        policyVerdict: { decision: string };
      };
    };
    expect(response.status).toBe(201);
    expect(body.intent.text).toBe("Pay the vendor $600.00 for the invoice.");
    expect(body.intent.proposal.amount).toBe(60000);
    expect(body.intent.policyVerdict.decision).toBe("needs_approval");
    expect(body.intent.status).toBe("executing");
    expect((await intents.findById(body.intent.id))?.executionProfile).toBe(
      "demo_decline",
    );
    expect(core.calls).toHaveLength(1);
    expect(core.calls[0]?.request).toMatchObject({
      amount: 60000,
      currency: "USD",
      paymentMethodToken: `sim.decline.insufficient_funds.${body.intent.id}`,
    });
  });
  it("fails closed by default and rejects arbitrary challenge controls", async () => {
    const disabled = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: "configured",
    });
    expect((await challenge(disabled.app, "duplicates")).status).toBe(404);
    const enabled = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: "configured",
      demoChallengesEnabled: true,
    });
    expect((await challenge(enabled.app, "arbitrary")).status).toBe(400);
    expect(
      (
        await enabled.app.request("/demo/challenges", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-customer-id": "owner",
          },
          body: JSON.stringify({
            scenario: "duplicates",
            paymentMethodToken: "unsafe",
          }),
        })
      ).status,
    ).toBe(400);
  });
  it("does not accept a profile through ordinary public submit", async () => {
    const { app, intents } = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: "configured",
      demoChallengesEnabled: true,
    });
    const response = await app.request("/intents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-id": "owner" },
      body: JSON.stringify({
        text: "Pay the vendor $50.00.",
        executionProfile: "demo_decline",
      }),
    });
    const body = (await response.json()) as { intent: { id: string } };
    expect(
      (await intents.findById(body.intent.id))?.executionProfile,
    ).toBeNull();
  });
  it("keeps profile metadata atomic and unchanged across aggregate updates", async () => {
    const repo = new InMemoryIntentRepository();
    const intent = Intent.submit({
      id: "profile-owner",
      customerId: "owner",
      text: "Pay vendor $500",
    });
    const stored = await repo.create(intent, {
      executionProfile: "demo_transient",
    });
    Object.assign(stored, { executionProfile: "demo_decline" });
    await repo.update(stored.intent, stored.version);
    expect((await repo.findById(intent.id))?.executionProfile).toBe(
      "demo_transient",
    );
    expect(intent.toState()).not.toHaveProperty("executionProfile");
  });
  it.each(["approve", "auto"])(
    "%s refuses a stored profile when the resolver is disabled",
    async (path) => {
      const repo = new InMemoryIntentRepository(),
        core = new FakeAgentCoreClient();
      const intent = Intent.fromState({
        id: "profile-owned",
        customerId: "owner",
        text: "Pay the vendor $500.00",
        status: path === "approve" ? "needs_approval" : "proposed",
        proposal: {
          kind: "propose_payment",
          amount: 50000,
          currency: "USD",
          merchantId: "vendor",
          reasoning: "source",
        },
        policyVerdict:
          path === "approve"
            ? {
                decision: "needs_approval",
                reason: "above_auto_approve_threshold",
                detail: "review",
              }
            : { decision: "allow" },
        durableLedgerEventId: null,
        clarificationAnswer: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await repo.create(intent, { executionProfile: "demo_transient" });
      const credentials = new DemoExecutionCredentials(false);
      const operation =
        path === "approve"
          ? new ApproveIntent(
              repo,
              core,
              "live-configured",
              () => new Date(),
              credentials,
            ).execute({ intentId: intent.id })
          : new AutoApproveIntent(
              repo,
              core,
              "live-configured",
              { maxAutoApproveAmount: 100000 },
              () => new Date(),
              credentials,
            ).execute({ intentId: intent.id, customerId: "owner" });
      await expect(operation).rejects.toMatchObject({ code: "demo_disabled" });
      expect(core.calls).toHaveLength(0);
    },
  );
  it("gives two simultaneous visitors independent first authorize AND capture faults in the actual simulator", async () => {
    const core = new FakeAgentCoreClient();
    const { app } = createInMemoryAgentOrchestrator({
      agentCore: core,
      paymentMethodToken: "configured",
      demoChallengesEnabled: true,
    });
    const results = await Promise.all([
      challenge(app, "temporary_failure", "visitor-a"),
      challenge(app, "temporary_failure", "visitor-b"),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const tokens = core.calls.map((c) => c.request.paymentMethodToken);
    expect(new Set(tokens).size).toBe(2);
    // Runtime-only contract test of the real simulator, without a production dependency.
    const { SimulatorProvider } = (await import(
      new URL(
        "../../../pay-core/src/adapters/simulator/simulator-provider.ts",
        import.meta.url,
      ).href
    )) as {
      SimulatorProvider: new () => {
        authorize(p: {
          paymentId: string;
          amount: unknown;
          paymentMethodToken: string;
        }): Promise<{ providerRef: string }>;
        capture(p: { providerRef: string; amount: unknown }): Promise<void>;
      };
    };
    const { Money } = (await import(
      new URL("../../../pay-core/src/domain/money.ts", import.meta.url).href
    )) as { Money: { of(n: number, c: string): unknown } };
    const provider = new SimulatorProvider();
    const amount = Money.of(50000, "USD");
    for (const token of tokens) {
      await expect(
        provider.authorize({
          paymentId: "p",
          amount,
          paymentMethodToken: token,
        }),
      ).rejects.toThrow();
      const { providerRef } = await provider.authorize({
        paymentId: "p",
        amount,
        paymentMethodToken: token,
      });
      await expect(provider.capture({ providerRef, amount })).rejects.toThrow();
      await expect(
        provider.capture({ providerRef, amount }),
      ).resolves.toBeUndefined();
    }
  });
});
