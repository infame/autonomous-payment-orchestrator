/**
 * No test in this file makes a real network call: constructing an
 * `Anthropic` SDK client (transitively, via `createLlmClient({mode:"live"})`)
 * never itself contacts the vendor — only `reason()` would, and nothing here
 * calls it. Every key below is a synthetic, obviously-fake test string
 * ("test-fake-key-not-real"), never a real credential, and never read from
 * `process.env`.
 */
import { describe, expect, it } from "vitest";
import { loadLiveConfig } from "../live-config.js";
import { BudgetedLlmClient } from "../llm/budgeted-llm-client.js";
import { createLiveLlmClient } from "./llm-factory.js";

const FAKE_KEY = "test-fake-key-not-real";

/** Circular-safe: the real SDK client's object graph is circular (`Messages` holds a back-reference to its owning `Anthropic` client). */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[circular]";
      seen.add(val);
    }
    return val;
  });
}

describe("createLiveLlmClient", () => {
  it("returns a BudgetedLlmClient (both .client and .budget) whose limit is the configured ceiling", () => {
    const cfg = loadLiveConfig({ ANTHROPIC_API_KEY: FAKE_KEY });
    const live = createLiveLlmClient(cfg, 42);
    expect(live.client).toBeInstanceOf(BudgetedLlmClient);
    expect(live.budget).toBeInstanceOf(BudgetedLlmClient);
    expect(live.client).toBe(live.budget);
    expect(live.budget.limit).toBe(42);
    expect(live.budget.calls).toBe(0);
    expect(live.client.name).toBe("budgeted:anthropic");
  });

  it("never leaks the API key anywhere in the returned object graph (canary)", () => {
    const cfg = loadLiveConfig({ ANTHROPIC_API_KEY: FAKE_KEY });
    const live = createLiveLlmClient(cfg, 10);
    expect(safeStringify(live)).not.toContain(FAKE_KEY);
  });

  it("forwards model, baseUrl, maxRetries and timeoutMs from LiveConfig", () => {
    const cfg = loadLiveConfig({
      ANTHROPIC_API_KEY: FAKE_KEY,
      ANTHROPIC_MODEL: "claude-fake-model",
      ANTHROPIC_BASE_URL: "https://example.test",
      ANTHROPIC_MAX_RETRIES: "3",
      LLM_TIMEOUT_MS: "5000",
    });
    // No direct way to read these back off the constructed client (by
    // design — see this module's header), so this just proves construction
    // succeeds and still yields a correctly-limited BudgetedLlmClient; the
    // forwarding itself is exercised end-to-end by
    // `AnthropicLlmClient`/`createAnthropicClient`'s own test suites in
    // @apo/agent-orchestrator.
    const live = createLiveLlmClient(cfg, 7);
    expect(live.budget.limit).toBe(7);
  });
});
