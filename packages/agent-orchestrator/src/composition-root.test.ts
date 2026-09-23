import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createAgentOrchestrator,
  createInMemoryAgentOrchestrator,
  createLlmClient,
} from "./composition-root.js";
import { FakeAgentCoreClient } from "./adapters/memory/fake-agent-core-client.js";
import { LlmConfigurationError } from "./ports/llm-client.js";

const TOKEN = "pm_test_token";
// $50.00 -> 5000 minor units, below the default maxAutoApproveAmount
// (50_000) but well above a maxAutoApproveAmount of 1 — see test 3.
const ALLOW_TEXT = "Pay the vendor $50.00 for the invoice.";
const CANARY_API_KEY = "sk-test-canary-should-never-leak-71390";

interface IntentJSON {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
}
interface VerdictJSON {
  readonly decision: string;
}
interface SubmitResponseJSON {
  readonly intent: IntentJSON;
  readonly verdict: VerdictJSON | null;
}

describe("createInMemoryAgentOrchestrator", () => {
  it("builds an app whose /healthz responds 200", async () => {
    const { app } = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: TOKEN,
    });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
  });

  it("wires all six use-cases against one shared repository, with ownership scoping intact end-to-end", async () => {
    const { app } = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: TOKEN,
    });

    const submitRes = await app.request("/intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Customer-Id": "cust_1",
      },
      body: JSON.stringify({ text: ALLOW_TEXT }),
    });
    expect(submitRes.status).toBe(201);
    const submitted = (await submitRes.json()) as SubmitResponseJSON;
    expect(submitted.verdict).not.toBeNull();
    const intentId = submitted.intent.id;

    const ownerGetRes = await app.request(`/intents/${intentId}`, {
      headers: { "X-Customer-Id": "cust_1" },
    });
    expect(ownerGetRes.status).toBe(200);

    const strangerGetRes = await app.request(`/intents/${intentId}`, {
      headers: { "X-Customer-Id": "cust_2" },
    });
    expect(strangerGetRes.status).toBe(404);
  });

  it("actually applies a non-default policy to the submitted proposal", async () => {
    const defaultPolicy = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: TOKEN,
    });
    const strictPolicy = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: TOKEN,
      policy: { maxAutoApproveAmount: 1 },
    });

    const request = (): RequestInit => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Customer-Id": "cust_1",
      },
      body: JSON.stringify({ text: ALLOW_TEXT }),
    });

    const defaultRes = await defaultPolicy.app.request("/intents", request());
    const strictRes = await strictPolicy.app.request("/intents", request());

    const defaultBody = (await defaultRes.json()) as SubmitResponseJSON;
    const strictBody = (await strictRes.json()) as SubmitResponseJSON;

    expect(defaultBody.verdict?.decision).toBe("allow");
    expect(strictBody.verdict?.decision).toBe("needs_approval");
  });

  it("calls resolvePolicyConfig at construction time, not merely at first use", () => {
    // JPY rejection is policy/rules.ts-private (zero-decimal currency); it is
    // never checked by config.ts's own POLICY_ALLOWED_CURRENCIES validation.
    expect(() =>
      createInMemoryAgentOrchestrator({
        agentCore: new FakeAgentCoreClient(),
        paymentMethodToken: TOKEN,
        policy: { allowedCurrencies: ["JPY"] },
      }),
    ).toThrow(/zero-decimal/);
  });

  it("threads paymentMethodToken through to ApproveIntent's own blank-token guard", () => {
    expect(() =>
      createInMemoryAgentOrchestrator({
        agentCore: new FakeAgentCoreClient(),
        paymentMethodToken: "   ",
      }),
    ).toThrow(/paymentMethodToken must not be blank/);
  });

  it("returns a policy field reflecting the default resolved config", () => {
    const { policy } = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: TOKEN,
    });
    expect(policy.maxAutoApproveAmount).toBe(50_000);
  });

  it("returns a policy field reflecting an overridden resolved config", () => {
    const { policy } = createInMemoryAgentOrchestrator({
      agentCore: new FakeAgentCoreClient(),
      paymentMethodToken: TOKEN,
      policy: { maxAutoApproveAmount: 1 },
    });
    expect(policy.maxAutoApproveAmount).toBe(1);
  });

  it("wires AutoApproveIntent into buildApp: a keyed, allow-verdict POST /intents reaches executing end-to-end", async () => {
    const agentCore = new FakeAgentCoreClient();
    const { app } = createInMemoryAgentOrchestrator({
      agentCore,
      paymentMethodToken: TOKEN,
    });

    const res = await app.request("/intents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Customer-Id": "cust_1",
        "Idempotency-Key": "idem-wiring-check",
      },
      body: JSON.stringify({ text: ALLOW_TEXT }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SubmitResponseJSON;
    expect(body.intent.status).toBe("executing");
    expect(agentCore.runCount).toBe(1);
  });
});

describe("createLlmClient", () => {
  it("mode: mock builds MockLlmClient", () => {
    const client = createLlmClient({ mode: "mock" });
    expect(client.name).toBe("mock");
  });

  it("mode: live builds AnthropicLlmClient without making any network call at construction time", () => {
    const client = createLlmClient({
      mode: "live",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-5",
    });
    expect(client.name).toBe("anthropic");
  });

  it("mode: live with a blank apiKey throws LlmConfigurationError", () => {
    expect(() =>
      createLlmClient({
        mode: "live",
        apiKey: "   ",
        model: "claude-sonnet-5",
      }),
    ).toThrow(LlmConfigurationError);
  });

  it("mode: live never embeds the API key in the returned client's object graph", () => {
    // The SDK's `Messages` resource carries an internal `_client`
    // back-reference to its owning `Anthropic` client (and therefore,
    // transitively, the API key). `util.inspect` at unbounded depth walks
    // that whole graph the way a stray `console.log(orchestrator)` or a
    // structured-logger dump would — proving the key is unreachable here is
    // what actually pins createLlmClient's closure-only wiring (see
    // composition-root.ts's `createLlmClient`). `JSON.stringify` would just
    // throw on the SDK client's circular reference and prove nothing.
    const client = createLlmClient({
      mode: "live",
      apiKey: CANARY_API_KEY,
      model: "claude-sonnet-5",
    });
    expect(inspect(client, { depth: null })).not.toContain(CANARY_API_KEY);
  });
});

describe("createAgentOrchestrator", () => {
  it("builds a working app against a lazily-connecting pg Pool (no live Postgres required)", async () => {
    const orchestrator = createAgentOrchestrator({
      durableLedgerServiceSecret: "s".repeat(32),
      databaseUrl: "postgres://u:p@localhost:5432/db",
      durableLedgerUrl: "http://localhost:3100",
      paymentMethodToken: TOKEN,
      llm: { mode: "mock" },
    });
    try {
      const res = await orchestrator.app.request("/healthz");
      expect(res.status).toBe(200);
      expect(orchestrator.llm.name).toBe("mock");
    } finally {
      await orchestrator.close();
    }
  });
});
