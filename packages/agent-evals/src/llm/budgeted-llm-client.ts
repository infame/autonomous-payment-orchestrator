/**
 * `BudgetedLlmClient`: wraps a real `LlmClient` (live mode, step 7) behind a
 * hard call-count ceiling. `eval:live` runs a real vendor model with a real
 * key against the whole hostile corpus at k passes — without a ceiling, a
 * misconfigured `--k`/corpus size, or a runaway retry loop upstream, could
 * spend an unbounded amount of money. This is a COUNT ceiling, not a cost
 * cap: a expensive multi-thousand-token call and a one-word decline both cost
 * exactly 1 against `limit` (see README's Live section for the caveat).
 *
 * `LiveBudgetExhaustedError` is deliberately NOT an `LlmClientError` — same
 * reason `ScriptExhaustedError` (`scripted-llm-client.ts`) isn't: a member of
 * the port's closed rejection set gets laundered by `server-error-mapper.ts`
 * into a tidy "agent failed" HTTP response and would masquerade as SUT
 * behaviour, when it is actually a harness-level stop condition.
 *
 * The counter increments BEFORE delegating to `inner.reason()`, not after a
 * successful resolution: a call that times out, 429s, or otherwise rejects
 * still went out over the wire (and, for a real vendor, still may be
 * billed), so it must still count against the budget. `failuresByCode` tallies
 * `LlmClientError.code` (never a message or the underlying request/response
 * body) so a live report can show *why* calls failed without risking a leak.
 */
import type {
  AgentProposal,
  LlmClient,
  LlmReasoningRequest,
} from "@apo/agent-orchestrator";
import { LlmClientError } from "@apo/agent-orchestrator";

export class LiveBudgetExhaustedError extends Error {
  constructor(readonly limit: number) {
    super(`BudgetedLlmClient: call budget of ${String(limit)} exhausted`);
    this.name = "LiveBudgetExhaustedError";
  }
}

export class BudgetedLlmClient implements LlmClient {
  readonly name: string;

  private callCount = 0;
  private readonly failures: Record<string, number> = {};

  constructor(
    private readonly inner: LlmClient,
    readonly limit: number,
  ) {
    this.name = `budgeted:${inner.name}`;
  }

  get calls(): number {
    return this.callCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.callCount);
  }

  get exhausted(): boolean {
    return this.callCount >= this.limit;
  }

  get failuresByCode(): Readonly<Record<string, number>> {
    return { ...this.failures };
  }

  async reason(input: LlmReasoningRequest): Promise<AgentProposal> {
    if (this.callCount >= this.limit) {
      throw new LiveBudgetExhaustedError(this.limit);
    }
    this.callCount += 1;
    try {
      return await this.inner.reason(input);
    } catch (err) {
      const code = err instanceof LlmClientError ? err.code : "other";
      this.failures[code] = (this.failures[code] ?? 0) + 1;
      throw err;
    }
  }
}
