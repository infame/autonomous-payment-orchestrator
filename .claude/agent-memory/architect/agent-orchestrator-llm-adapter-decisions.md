---
name: agent-orchestrator-llm-adapter-decisions
description: agent-orchestrator step 7 design calls — three response tools not one, why the adapter must NOT re-check grounding, why the API key never reaches the adapter object, why the vendor SDK is faked structurally instead of over a socket (inverting ADR-0006), and the 4xx-vs-retryable error gap.
metadata:
  type: project
---

Decided 2026-09-17 while planning spec step 7 of
`docs/todo/03-agent-orchestrator.md` (`AnthropicLlmClient`). See
[[anthropic-sdk-constraints]] for the verified SDK facts these rest on.

**Three tools (`propose_payment`, `ask_clarifying_question`, `decline`) with
`tool_choice: {type:"any", disable_parallel_tool_use:true}` — not one tool
plus parsed prose.**
**Why:** the model then has exactly one output channel per response and the
adapter never parses free text, so every malformed answer is a structural
condition (no tool block / >1 block / unknown name / bad args) with a clean
typed error. Spec §13's "one instrument — `propose_payment` IS the whole tool
set" is about not growing a second *capability* (`propose_refund`); `clarify`
and `decline` move nothing and add no capability, they are response channels
for the same one scenario. Spec §5 explicitly leaves this choice to
implementation time.
**How to apply:** if a reviewer objects on §13 grounds, the reconciliation is
"capability vs. channel", not a redesign. A fourth tool that *does* something
is the line.

**The adapter must NOT re-check `amount-must-be-grounded`, or filter/repair
anything the model returns.**
**Why:** the system prompt steers (ask for the minimum grounded candidate or
clarify, §3.3); `evaluatePolicy`'s `amountMustBeGrounded` enforces. If the
adapter silently dropped an ungrounded proposal, the adversarial proposal
would never be persisted on the `Intent`, destroying the audit trail spec §1
requires and the `agent-evals` signal §3.3 exists to produce — and the mock
and live paths would then feed policy different things.
**How to apply:** the only thing the adapter is allowed to reject is a
response it cannot turn into a *domain-valid* `AgentProposal`. Domain-valid
but policy-hostile must flow through untouched.

**The API key never reaches `AnthropicLlmClient`. The class takes a narrow
structural `{ create(params, options) }` interface (the `client.messages`
object), and a separate `createAnthropicClient({apiKey, ...})` factory owns
the key and the blank-key guard — mirroring durable-ledger's
`createInngestClient`.**
**Why:** the key cannot then appear on the adapter instance, in its stack
frames, or in any error it builds, which is exactly the "key never leaves the
server" claim spec §5 asks the README to make. The narrow interface also lets
the unit tests inject a plain object instead of casting a stub to the whole
`Anthropic` class.

**Faking the SDK structurally, NOT a `node:http` fake server — this
deliberately inverts ADR-0006.** ADR-0006 chose a real socket for
`HttpPayCoreClient` because the risky code WAS the fetch/`AbortSignal`/timeout
plumbing, which this package owns. Here the transport belongs to the vendor
SDK; the risky code is prompt/tool assembly and response interpretation. A
socket-level fake would test the SDK and would pin us to a vendor wire format
we do not own. Worth its own short ADR.

**Gap found: `LlmUnavailableError.retryable` is a fixed `true`, so a 401/403/
400 has nowhere correct to land — `LlmProtocolError` ("returned an unusable
response") is semantically wrong for a bad API key.** Recommended fix is a
third port error, `LlmConfigurationError` (retryable `false`), for
status < 500 excluding 408/429, plus the blank-key guard. Precedent:
`AgentCoreBadRequestError` gets its own non-retryable class rather than being
crammed into the retryable one, and `AgentCoreUnexpectedResponseError`
computes `retryable` from `status >= 500 || 429 || 408` — reuse that exact
predicate. Spec §9's error table only knows `LlmUnavailableError`, so step 8's
HTTP mapper needs a row added for it (500, not 503).
