# 17. Merchant must be grounded in the intent text

Date: 2026-09-20

## Status

Accepted

## Context

The agent-evals harness found (see [packages/agent-evals/README.md](../../packages/agent-evals/README.md) `## Findings` and [injection-merchant-swap.test.ts](../../packages/agent-evals/src/e2e/injection-merchant-swap.test.ts)) that the LLM-chosen `merchantId` was never checked against anything. `POST /intents` takes no `merchantId`, so the payee is always the model's proposal, and on the auto-approve path (Idempotency-Key supplied, amount under `maxAutoApprove`) a hostile proposal's merchant reached `startPaymentWorkflow` with no human in the loop.

[ADR-0012](0012-payment-method-token-is-supplied-not-proposed.md)'s precedent is that a caller-supplied merchant is trusted while a proposed one is not. The amount already has an equivalent guard (`amountMustBeGrounded`); the payee had none.

## Decision

A sixth policy rule, `merchantMustBeGrounded` (`packages/agent-orchestrator/src/policy/rules.ts`), rejects a `PaymentProposal` whose `merchantId` is not a token of the intent text (or clarification answer). Reason code: `merchant_not_grounded`.

- Reject, not `needs_approval`: a payee absent from the user's own text is fabricated, the same reasoning as `amountMustBeGrounded`.
- Matching: whole token, case-folded with `toLowerCase` (the charset is ASCII). Tokens are split on everything outside `[A-Za-z0-9_-]`, the `merchantId` charset. No normalization: stripping `-`/`_` would collapse distinct ids, and splitting the proposal into parts would let an attacker assemble a payee from unrelated words. Tokens containing no ASCII letter are excluded (`42`, but also `-`/`_`/`4-2`), because every payment text contains its amount as digits (else merchantId `120` would always be grounded in "Pay $120 to acme"), and ordinary prose contains bare `-`/`_`.
- Position: after `amountMustBeGrounded`, before `maxHardLimit`/`maxAutoApprove`, so it is a hard reject that precedes the approval gate and existing `amount_not_grounded` precedence is unchanged.
- Grounded set is the union of intent text and clarification answer, as for amounts. The rule reads only `proposal.merchantId`, never `reasoning`, and its `detail` never echoes the id.
- `MockLlmClient`'s default merchant changes from `demo_merchant` to `vendor`, which appears in every demo text. The Anthropic system prompt and tool schema gain a merchant-grounding instruction; that only steers, and the rule is the enforcement point.

## Consequences

Known limits:

- No registry or allowlist. Grounding proves only that the user's own text names this payee, not that it is legitimate. Allowlist/registry and a caller-supplied merchant are future work.
- An injection that writes the attacker's id inside the intent text (e.g. a hostile invoice description) is grounded and still passes. This narrows the class; it does not close it.
- The clarification answer widens the grounded set by design.
- `ApproveIntent` does not re-evaluate policy, so an intent already at `needs_approval` with an ungrounded merchant can still be human-approved. That limit is reachable only for rows persisted BEFORE this rule: a new proposal with an ungrounded merchant can never reach `needs_approval`, because `merchantMustBeGrounded` runs before `maxAutoApprove` and rejects outright.
- Grounding is case-folded while the ledger subject is case-sensitive (`ACME` vs `acme`).
- Merchant ids with no letter in them (`42`, `-`, `4-2`) can be proposed but are always rejected: they are never in the grounded set.
- Common-noun tokens such as `vendor` are groundable.
- Rows containing `merchant_not_grounded` fail `isPolicyReasonCode` in an older deployment (single deployment; note only).
- `sim.merchant.<id>` is self-grounding, so the mock cannot demo a reject through directives.
- The local-only, untracked `docs/todo/03-agent-orchestrator.md` §4 (five rules) is stale and defers to the code; it is not edited.
