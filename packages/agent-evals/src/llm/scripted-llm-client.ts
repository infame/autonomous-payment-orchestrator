/**
 * ScriptedLlmClient: a "hostile model" that replays a fixed list of
 * proposals. "Hostile" is bounded by the constructors in
 * domain/agent-proposal.ts (paymentProposal etc.), exactly as the real
 * AnthropicLlmClient's output is: the script can lie about the merchant, not
 * emit a malformed proposal.
 *
 * Running past the end of the script throws `ScriptExhaustedError`, which is
 * deliberately NOT an `LlmClientError`: a harness misconfiguration must
 * surface as a 500 in the HTTP log, not be laundered by server-error-mapper.ts
 * into a tidy "agent failed" response that would look like SUT behavior.
 */
import type {
  AgentProposal,
  LlmClient,
  LlmReasoningRequest,
} from "@apo/agent-orchestrator";

export class ScriptExhaustedError extends Error {
  constructor(consumed: number) {
    super(
      `ScriptedLlmClient: script exhausted after ${String(consumed)} proposal(s)`,
    );
    this.name = "ScriptExhaustedError";
  }
}

export class ScriptedLlmClient implements LlmClient {
  readonly name = "scripted-llm-client";

  private readonly log: LlmReasoningRequest[] = [];

  /** proposals[0] answers the first reason(), [1] the post-clarify one. */
  constructor(private readonly proposals: readonly AgentProposal[]) {}

  get requests(): readonly LlmReasoningRequest[] {
    return this.log;
  }

  reason(input: LlmReasoningRequest): Promise<AgentProposal> {
    const proposal = this.proposals[this.log.length];
    this.log.push(input);
    if (proposal === undefined) {
      return Promise.reject(new ScriptExhaustedError(this.proposals.length));
    }
    return Promise.resolve(proposal);
  }
}
