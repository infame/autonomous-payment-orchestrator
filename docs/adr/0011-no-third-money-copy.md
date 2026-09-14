# 11. No third `Money` copy in `agent-orchestrator`

Date: 2026-09-14

## Status

Accepted

## Context

[ADR-0005](0005-duplicate-money-across-packages.md) established that
`durable-ledger` needed its own copy of `pay-core`'s `Money` value object —
same arithmetic semantics (integer minor units, explicit ISO-4217 currency,
throw not coerce, cross-currency guard), independently owned because
`pay-core` wasn't (and by the spec, shouldn't be) importable as a workspace
library. That ADR's own Consequences section named the trigger for
revisiting the decision: "if a third package ever needs the same value
object... extract a genuinely shared library... rather than a third copy."

`agent-orchestrator`'s domain and policy layer (this step) is the third
package to touch a payment amount at all. But it does not need the *value
object's behavior* — no `add`/`subtract`/`sum`, no cross-currency guard, no
balance projection. Every place an amount is used, it's either:

- compared to a scalar threshold (`maxAutoApproveAmount`,
  `maxHardLimitAmount` in `src/policy/rules.ts`), or
- tested for set membership against amounts extracted from free text
  (`extractGroundedAmounts` in `src/policy/grounding.ts`).

Neither operation needs a `Money` class; a plain `number` compared with
`>=`/`>` or `Set.has` does the same job with less code and no cross-package
type to keep in sync.

## Decision

`PaymentProposal.amount` (`src/domain/agent-proposal.ts`) and every
threshold in `PolicyConfig` (`src/policy/rules.ts`) are plain `number`s:
integer minor units, matching `pay-core`'s and `durable-ledger`'s own
convention. Concretely, this matches the literal body shape of the one HTTP
call this package will eventually make —
`durable-ledger`'s `paymentExecuteRequestedSchema.amount: z.number().int().positive()`
(`packages/durable-ledger/src/workflow/events.ts`). `currency` is a plain
uppercase ISO-4217 alpha-3 `string`, validated by regex at construction,
not wrapped in a value object either.

No `Money` type — duplicated or shared — is introduced in this step.

## Consequences

- No `Money` arithmetic bugs are possible in this package, because there is
  no `Money` arithmetic: amounts are opaque integers to every function that
  handles them here except comparison and set membership.
- Currency correctness (matching units to currency) is the caller's
  responsibility at the point an amount is constructed
  (`paymentProposal(...)`) — there is no type-level guard preventing a
  mismatched minor-unit assumption the way a real `Money` class would. This
  is an accepted, narrower version of the same trade-off ADR-0005 already
  made explicit for `durable-ledger`.
- **When to revisit:** the moment any step in this package needs real
  arithmetic on amounts — a cumulative-amount rate limit (summing multiple
  proposals' amounts), or an FX/cross-currency comparison — is the trigger
  to extract a genuinely shared value-object package (giving `pay-core` a
  real `exports` field), per ADR-0005's own Consequences, not to write a
  third copy of `Money` at that point.
