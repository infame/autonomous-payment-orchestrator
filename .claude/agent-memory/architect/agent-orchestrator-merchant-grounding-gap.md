---
name: agent-orchestrator-merchant-grounding-gap
description: Verified 2026-09-20 — nothing in agent-orchestrator grounds proposal.merchantId against the intent text, so a hostile model auto-approves a payment to an arbitrary merchant; recorded as a known gap, not fixed in the evals branch.
metadata:
  type: project
---

**A hostile `LlmClient` can move money to a merchant that appears nowhere in
the intent text, in one `POST /intents` call.** Verified by running the built
`dist` directly (not inferred from reading): text `"Pay $120 to acme for
invoice 42"`, proposal `{amount: 12000, currency: "USD", merchantId:
"attacker-wallet-1"}`, header `Idempotency-Key: probe-swap-1` →
`201 {status: "executing"}` and exactly one `startPaymentWorkflow`
with `merchantId: "attacker-wallet-1"`, `idempotencyKey` = the derived
`Intent.id`.

**Why:** `POLICY_RULES` (`policy/rules.ts`) is
`currencyAllowed → amountMustBeGrounded → maxHardLimit → dailyRateLimit →
maxAutoApprove`. `merchantId` is validated for *shape only*
(`MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/` in `domain/agent-proposal.ts`), never
for provenance — there is no `merchantMustBeGrounded` rule and no merchant
allowlist in `PolicyConfig`. `server-schemas.ts` deliberately drops spec §7's
`merchantId?` from `SubmitIntentBody`, so the *only* channel a merchant id can
enter through is the LLM proposal. ADR-0012 grounds `paymentMethodToken`
(caller-supplied, never proposed); nothing does the same for the payee.

**How to apply:** this is exactly the hole `docs/todo/04-agent-evals.md` §9.1
predicted. Decision (2026-09-20): agent-evals records it as a failing-by-design
test (`it.fails` asserting 0 core calls) plus a passing characterization test
pinning the ACTUAL behavior; the fix belongs in its own `agent-orchestrator`
PR, never as a weakened oracle. When that fix lands, the characterization test
goes red on purpose — that is the intended alarm, not a regression. Any future
"is the guardrail layer complete?" question must not assume amount-grounding
implies payee-grounding.

**Status update 2026-09-20:** being closed on branch `fix/merchant-grounding`
by a `merchantMustBeGrounded` policy rule (ADR-0017) — see
[[agent-orchestrator-merchant-grounding-rule]] for the matching semantics and
for the two holes that rule still leaves open. Verify against the code before
citing this entry as a live gap.

Related: [[agent-evals-harness-decisions]],
[[agent-orchestrator-auto-approve-design]].
