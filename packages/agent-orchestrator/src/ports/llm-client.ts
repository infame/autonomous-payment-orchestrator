import type { AgentProposal } from "../domain/agent-proposal.js";

/**
 * `LlmClient` is the outbound port to whatever produces an `AgentProposal`
 * from natural-language intent text — a real vendor model (step 7,
 * `AnthropicLlmClient`) or the deterministic, directive-driven `MockLlmClient`
 * (this step). The domain and (future) use-case layer depend on this
 * interface only; neither imports a vendor SDK.
 *
 * ## The `reason()` contract
 *
 * `reason()` either:
 *  - resolves with an `AgentProposal` that has ALREADY passed domain
 *    validation — every implementation MUST build its return value through
 *    `paymentProposal()` / `clarifyProposal()` / `declineProposal()`
 *    (`domain/agent-proposal.js`), never as a raw object literal. A caller of
 *    this port is entitled to assume `InvalidProposalError` can never escape
 *    `reason()`; that error is a fabrication-time concern inside an
 *    `LlmClient` implementation, not a runtime concern for its callers.
 *  - or rejects with an `LlmClientError` subclass, and nothing else. A
 *    caller catching a rejection from `reason()` never needs a fallback
 *    `catch`-all for "some other kind of error" — the rejection set is
 *    closed and stated below: exactly three subclasses,
 *    `LlmUnavailableError` (transport), `LlmConfigurationError` (a vendor
 *    rejection of the request itself), and `LlmProtocolError` (an
 *    unusable response).
 *
 * ## Why `clarificationAnswer` is `string | null`, not spec §5's `?: string`
 *
 * The spec's own sketch (§5) writes `clarificationAnswer?: string`. This
 * port deliberately encodes it as `string | null` instead, for two reasons:
 * under `exactOptionalPropertyTypes: true` an optional field can't be
 * forwarded into `PolicyContext.clarificationAnswer` (`policy/evaluate-policy.js`,
 * already `string | null`) without every caller writing a conditional
 * spread just to bridge "absent" between the two encodings; and more
 * fundamentally, the *absence* of a clarification answer is exactly the
 * kind of semantically-meaningful, must-handle case this repo's convention
 * reserves for `| null`, not `?:`. The house rule (see `agent-proposal.ts`,
 * `evaluate-policy.ts`): `?:` means the caller may omit the field and the
 * callee is free to default it; `| null` means the data is legitimately
 * absent and the callee MUST branch on it. Whether a clarification round has
 * happened yet changes `reason()`'s entire behaviour (see
 * `MockLlmClient`'s header for the concrete case: a `clarify` outcome is
 * only legal when `clarificationAnswer === null`) — that's a branch, not a
 * default.
 *
 * ## Why `LlmClientError` is not an `OrchestratorError`
 *
 * A failed call to a model vendor is a transport failure — the vendor's API
 * was unreachable, rate-limited, or returned garbage — not a violation of
 * this package's own domain invariants. `domain/errors.ts` documents the
 * same split from the other side: `OrchestratorError` models invariants
 * `Intent`/`AgentProposal` enforce on themselves, and explicitly carves out
 * `LlmUnavailableError` as belonging here instead. This mirrors
 * `durable-ledger`'s `PayCoreClientError` vs `LedgerError`
 * (`packages/durable-ledger/src/ports/pay-core-errors.ts`): a failed call to
 * an external system's own port-level error hierarchy, kept separate from
 * the domain it happens to be adjacent to.
 *
 * ## On `LlmProtocolError` and `LlmConfigurationError`
 *
 * `AnthropicLlmClient` (`src/adapters/llm/anthropic-llm-client.ts`, step 7)
 * is the first — and, as of this writing, only — class that constructs
 * either. `MockLlmClient` is deterministic by construction, so it has no
 * "the model said something we can't parse" or "the vendor rejected the
 * request" failure mode to simulate. Both were declared here well before
 * that, because the `reason()` contract's full rejection set must be stated
 * in the same place the contract itself is stated, not bolted on
 * retroactively once the first class that throws it exists.
 *
 * ## The discipline every real adapter's error mapping must follow
 *
 * `AnthropicLlmClient`'s own error mapper (`adapters/llm/anthropic-errors.ts`)
 * is the concrete enforcement of this rule, but it's stated here because it's
 * a port-level invariant, not an implementation detail of one adapter: any
 * error message built from this port's errors must never include a raw
 * prompt, a raw vendor response body, or a raw vendor error message — only
 * structural facts (an HTTP status, the vendor's error-type discriminator, a
 * request id, whether the failure was a transport error vs. an unparseable
 * response, etc.). Same discipline `PayCoreClientError`'s header requires for
 * request bodies and tokens (`packages/durable-ledger/src/ports/pay-core-errors.ts`):
 * a natural-language prompt is even more likely to carry sensitive customer
 * content than a structured payment request body, so the bar here is at
 * least as strict.
 */
export interface LlmReasoningRequest {
  readonly intentText: string;
  readonly clarificationAnswer: string | null;
}

export interface LlmClient {
  readonly name: string;
  reason(input: LlmReasoningRequest): Promise<AgentProposal>;
}

export abstract class LlmClientError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

/** The LLM vendor could not be reached or answer in time (network, 5xx, timeout, rate limit). Retrying may succeed. */
export class LlmUnavailableError extends LlmClientError {
  readonly code = "llm_unavailable";
  readonly retryable = true;
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`LLM unavailable: ${reason}`, cause);
  }
}

/**
 * The vendor rejected the request itself — bad/absent credentials, a bad
 * model id, a malformed tool schema. A deployment/configuration fault, not
 * a transport blip and not model misbehaviour. Terminal: identical bytes
 * with identical config fail identically.
 */
export class LlmConfigurationError extends LlmClientError {
  readonly code = "llm_configuration_error";
  readonly retryable = false;
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`LLM client is misconfigured: ${reason}`, cause);
  }
}

/**
 * The LLM answered, but its response could not be turned into a valid
 * `AgentProposal` (unparseable output, a schema the model didn't honour,
 * etc.). See this file's header for the first class that constructs it.
 * Terminal: retrying the identical request to a model that just misbehaved
 * is not expected to reliably fix it.
 */
export class LlmProtocolError extends LlmClientError {
  readonly code = "llm_protocol_error";
  readonly retryable = false;
  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`LLM returned an unusable response: ${reason}`, cause);
  }
}
