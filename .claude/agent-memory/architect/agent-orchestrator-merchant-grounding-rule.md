---
name: agent-orchestrator-merchant-grounding-rule
description: Design constraints behind merchantMustBeGrounded — why whole-token case-folded matching (no normalization), why digit-only tokens are excluded, why the mock's default merchant becomes "vendor", and the two residual holes the rule does NOT close.
metadata:
  type: project
---

Designed 2026-09-20 on `fix/merchant-grounding`, closing the gap recorded in
[[agent-orchestrator-merchant-grounding-gap]] (ADR-0017).

**Matching is whole-token, case-folded, with NO normalization — and
digit-only tokens are excluded from the grounded merchant set.**
**Why:** any looser scheme re-opens the hole it closes. Substring matching
lets `acme` ground `acmecorp-attacker`; stripping `-`/`_` collapses
genuinely distinct ids; splitting the *proposal* into parts and requiring
each part lets an attacker assemble a payee out of unrelated words in the
text. Digit-only exclusion is the non-obvious one: every payment text
contains the amount as digits, so without it `merchantId: "120"` is ALWAYS
grounded in `"Pay $120 to acme"` and a numeric wallet id walks straight
through — it is the merchant-side mirror of `grounding.ts`'s documented
"a date or reference number grounds a spurious amount" quirk.
**How to apply:** token charset must be exactly `agent-proposal.ts`'s
`MERCHANT_ID` charset (`[A-Za-z0-9_-]`), so the text is split on everything
outside it and a token is compared whole. Case-fold with `toLowerCase()`
(ASCII-only charset, so no locale trap) — but note the downstream ledger
subject `LedgerAccount.merchant(id)` IS case-sensitive, so case-insensitive
grounding does let `ACME` execute against a different ledger account than
the `acme` the user wrote. Accepted, documented, not fixable without a
registry.

**`sim.merchant.<id>` directives are SELF-GROUNDING by construction — the
directive arg is itself a token of the intent text.** **Why:** the
directive grammar is scanned out of `intentText`, and the merchant token
extractor splits on `.`, so `sim.merchant.attacker-wallet` puts
`attacker-wallet` into the grounded set. **How to apply:** `MockLlmClient`
can therefore never demonstrate a `merchant_not_grounded` reject via a
directive — an in-package end-to-end test of the new rule must use
`new MockLlmClient({ defaultMerchantId: "..." })` against text that does
not name it. Do NOT "fix" this by carving a reserved arg out of the
grammar (the `sim.amount.ungrounded` precedent does not transfer: that
selector exists because the grammar is digit-free, whereas a merchant
directive's arg is unavoidably text).

**`MockLlmClient`'s default merchant becomes the literal word `vendor`, and
that keeps the blast radius to one constant.** **Why:** verified by grep —
essentially every intent-text fixture in the package (`"Pay the vendor
$50.00 for the invoice."`, `"...for the vendor invoice. sim.clarify"`, the
`composition-root`/`app`/`submit-intent`/`auto-approve` ALLOW_TEXTs)
already contains that word, while `demo_merchant` appears in none of them.
**How to apply:** the rest of the fallout is mechanical (`demo_merchant` →
`vendor` in `mock-llm-client.test.ts` and two seeded-proposal fixtures).
`anthropic-llm-client.test.ts`'s `demo_merchant` fixtures are unrelated —
that adapter never runs policy; leave them.

**Refinement 2026-09-20 (review follow-up): the exclusion is "token contains
no ASCII letter", not "token is all digits".** **Why:** the token charset is
`[A-Za-z0-9_-]`, so `^\d+$` still admitted `-`, `_`, `--`, `4-2`. A bare
`-` or `_` appears in ordinary text ("Pay the vendor - $50.00"), which would
ground a merchantId of literally `-`. **How to apply:** test `/[A-Za-z]/` on
the raw token; `vendor-42` must still pass. The ADR's "all-numeric merchant
ids cannot be proposed" phrasing is wrong either way — such ids ARE
proposable (`paymentProposal()` accepts them), they are just always
rejected by this rule.

**Two holes the rule does NOT close.** (1) `ApproveIntent` never
re-evaluates policy, so an intent already parked at `needs_approval` with
an ungrounded merchant can still be human-approved into `executing`;
`AutoApproveIntent` DOES re-evaluate, so the auto path is covered.
(2) Grounding proves the payee is *named by the text*, not that it is
legitimate — an injection that writes the attacker's merchant id into the
intent text (a hostile invoice description) is grounded and passes. The
class narrows, it does not close; an allowlist/registry is the real fix and
is deliberately out of scope.

**No migration.** `agent.intents.policy_verdict` is plain `jsonb` with no
CHECK on reason codes; `drizzle/mappers.ts`'s `isPolicyReasonCode` is the
only gate, so a new `PolicyReasonCode` is a one-line change to
`POLICY_REASON_CODES` in `policy/verdict.ts`.
