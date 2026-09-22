/**
 * The ONE place in `@apo/agent-evals` a real API key value is ever passed
 * anywhere: `cfg.ANTHROPIC_API_KEY` (already validated by `loadLiveConfig`)
 * goes straight into `@apo/agent-orchestrator`'s exported `createLlmClient`,
 * which is itself the only place THAT package constructs a real `Anthropic`
 * SDK client (`createAnthropicClient`) and closes over it behind the narrow
 * `{ messages: { create } }` surface before ever handing it to
 * `AnthropicLlmClient` — see that package's `composition-root.ts` and
 * `anthropic-llm-client.ts` headers for why nothing reachable from the
 * returned client's own object graph carries the key. This module inherits
 * that property; it does not re-implement it.
 *
 * `BudgetedLlmClient` wraps the result before it goes anywhere else, so
 * every live call is metered from the very first `reason()`.
 */
import { createLlmClient } from "@apo/agent-orchestrator";
import type { LlmClient } from "@apo/agent-orchestrator";
import { BudgetedLlmClient } from "../llm/budgeted-llm-client.js";
import type { LiveConfig } from "../live-config.js";

export interface LiveLlm {
  readonly client: LlmClient;
  readonly budget: BudgetedLlmClient;
}

/**
 * `cfg.ANTHROPIC_API_KEY` is typed `string | undefined` (mirroring
 * `LiveConfig`'s schema shape) but is guaranteed defined at RUNTIME by the
 * time a `LiveConfig` value exists at all — `loadLiveConfig`'s `superRefine`
 * rejects a missing key before `.parse()` ever returns. The `undefined`
 * branch below is defensive only, never expected to run.
 */
export function createLiveLlmClient(
  cfg: LiveConfig,
  maxCalls: number,
): LiveLlm {
  const apiKey = cfg.ANTHROPIC_API_KEY;
  if (apiKey === undefined) {
    throw new Error(
      "createLiveLlmClient: ANTHROPIC_API_KEY missing from an already-validated LiveConfig",
    );
  }
  const client = createLlmClient({
    mode: "live",
    apiKey,
    model: cfg.ANTHROPIC_MODEL,
    ...(cfg.ANTHROPIC_BASE_URL === undefined
      ? {}
      : { baseUrl: cfg.ANTHROPIC_BASE_URL }),
    ...(cfg.ANTHROPIC_MAX_RETRIES === undefined
      ? {}
      : { maxRetries: cfg.ANTHROPIC_MAX_RETRIES }),
    timeoutMs: cfg.LLM_TIMEOUT_MS,
  });
  const budget = new BudgetedLlmClient(client, maxCalls);
  return { client: budget, budget };
}
