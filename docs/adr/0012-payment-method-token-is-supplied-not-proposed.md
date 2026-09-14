# 12. `paymentMethodToken` is a caller-supplied argument, never an LLM-proposed field

Date: 2026-09-14

## Status

Accepted

## Context

`durable-ledger`'s `paymentExecuteRequestedSchema`
(`packages/durable-ledger/src/workflow/events.ts`) requires a
`paymentMethodToken: z.string().min(1)` on every `POST /workflows/payment`
call. `agent-orchestrator`'s own `PaymentProposal`
(`packages/agent-orchestrator/src/domain/agent-proposal.ts`) has no such
field — deliberately: `PaymentProposal` is the LLM's structured output, and
the LLM must never be trusted to invent a payment credential. An `LlmClient`
is only obligated to reason about amount, currency, and merchant from
natural-language intent text; a payment method token is not something that
exists in that text to reason about, and letting the model emit one anyway
would mean trusting a non-deterministic component to originate the single
most sensitive value in the whole request.

Separately, `paymentMethodToken` is also the wire carrier for `pay-core`'s
`SimulatorProvider` directive grammar (`sim.ok`, `sim.decline.<code>`,
`sim.fail_then_succeed.<n>`, `sim.timeout`, …) — the mechanism this entire
portfolio project's demo relies on to produce a simulated 503 followed by a
durable retry, without a real payment network in the loop. That demo
requirement is unreachable unless something outside the LLM can set the
token to a specific directive string on a per-call basis; a value fixed at
adapter-construction time, or one the LLM is asked to guess, both fail this
requirement for different reasons (the former can't select `sim.timeout` for
one call and `sim.ok` for the next; the latter re-opens the trust problem
above).

## Decision

`paymentMethodToken` is threaded through `AgentCoreClient` as an explicit,
caller-supplied argument — see `paymentWorkflowRequestFor`
(`packages/agent-orchestrator/src/ports/agent-core-client.ts`), which takes
it as a sibling parameter to a `PaymentProposal`, not a field read off the
proposal itself. It is sourced from configuration in a later use-case step
(not built here), and is never hard-coded in this package and never
LLM-proposed. This keeps the LLM's blast radius bounded to amount/currency/
merchant/reasoning, while still letting a caller (a demo script, a future
use-case wired to config) select the exact `SimulatorProvider` directive a
given call should exercise.

A real per-customer stored-payment-method system — looking up a token by
`Intent.customerId`, card-on-file management, tokenization vault integration
— is explicitly out of scope for this portfolio project. The
config-supplied token is a deliberately simple stand-in for that system, not
an attempt to model it.

## Consequences

- The LLM's proposal surface stays exactly `{amount, currency, merchantId,
  reasoning}` (plus the `clarify`/`decline` variants) — no path exists for a
  prompt-injected or hallucinated value to become a payment credential.
- The demo's headline scenario (a simulated 503 from `pay-core` surfacing as
  a durable retry through `durable-ledger`) stays reachable: a caller can set
  `paymentMethodToken` to `sim.fail_then_succeed.<n>` (or any other directive)
  per call, independent of what the LLM proposed.
- A later step must design where the config-supplied token actually comes
  from (per-merchant config, a fixed demo value, an operator-supplied
  override) — deferred, not decided, by this ADR.
- `paymentWorkflowRequestFor` fails fast (throws `AgentCoreBadRequestError`
  before any I/O) on a blank token, so a caller that forgets to supply one
  finds out immediately, at the same layer that produced the mistake, rather
  than as an opaque 400 from `durable-ledger` later.
