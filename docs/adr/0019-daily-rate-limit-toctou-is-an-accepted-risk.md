# 19. Daily rate limit TOCTOU is an accepted risk

Date: 2026-09-22

## Status

Accepted

## Context

`dailyRateLimit` (`packages/agent-orchestrator/src/policy/rules.ts`) rejects a proposal when `completedIntentsLast24h >= config.dailyRateLimit` — a count of intents with status `completed` at PROPOSAL time. An intent only becomes `completed` on a LATER `GET /intents/:id` sync (`SyncIntentExecution`); nothing marks it completed at submit time. So N keyed submits issued back-to-back, with no sync call in between, all read the same (too-low) completed count and all pass a limit of N-1 — then all N go on to complete.

Measured (`packages/agent-evals/src/e2e/limits-rate-limit-toctou.test.ts`, `runRateLimitInFlight`): with `dailyRateLimit` 2 and no interleaved syncs, three in-flight submits all complete and I8 (`rate-limit.ts`) reports exactly one violation: `3 completed intents exceed the daily rate limit 2`. The same message text was reproduced independently during the step-8 mutation sweep (`packages/agent-evals/README.md`'s "The mutation sweep" section) by removing `dailyRateLimit` from `POLICY_RULES` entirely and running `limits-daily-rate-limit-01` — a different way of defeating the same check, same violation shape. The corpus counterpart `limits-daily-rate-limit-01` interleaves real `get` syncs between submits and is clean: the guardrail works correctly when the caller happens to synchronize.

Blast radius, stated precisely: this bug only multiplies the COUNT of otherwise-legal payments within a rate-limit window. It does not let a single ungrounded, over-hard-limit, wrong-currency, or foreign-owned payment through — `amountMustBeGrounded`, `merchantMustBeGrounded`, `maxHardLimit`, `currencyAllowed` and the HTTP ownership checks all still run, independently, per intent, regardless of how many in-flight submits are racing. A customer can get more payments through in a day than `dailyRateLimit` intends; they cannot get an individually unsafe payment through because of this bug.

## Decision

Accept this as a known risk. Do not fix it in this change (agent-evals step 8, a DoD sweep on the eval harness, not a fix to the SUT).

Rationale: `dailyRateLimit` is a throughput control, not a money-safety invariant — every guardrail that IS a money-safety invariant (grounding, merchant, hard limit, currency, tenancy) is unaffected and independently enforced per intent. A real fix requires a product/design decision inside `agent-orchestrator` that this task is not positioned to make:

- **Claim a slot at proposal time**, with its own persistence and release-on-reject semantics (what happens to the claimed slot if the proposal is later rejected, or the process crashes between claim and completion?), or
- **Count non-terminal in-flight intents** (not just `completed` ones) against the limit — which silently redefines the metric from "completed per day" to "attempted per day," a behavior change a caller would notice.

Either path is a real `agent-orchestrator` change needing its own ADR in that package. This task does not touch `packages/agent-orchestrator/` (source or docs) at all — see [ADR-0017](0017-merchant-must-be-grounded-in-the-intent-text.md) for the precedent of the opposite call: a finding from this same harness that WAS judged worth fixing, in that package, behind its own ADR. This finding is judged differently because its blast radius is bounded to throughput, not to an individual payment's safety.

## Consequences

- `src/e2e/limits-rate-limit-toctou.test.ts`'s `it.fails` (desired behaviour) plus its characterization test (today's behaviour, pinned) stay as-is. They are designed to flip together: if a future fix lands, the `it.fails` starts passing, vitest turns it red, and that is the forcing function to delete the characterization test and this pairing.
- `src/cli-fixtures/violating/` (the fixture the CLI exit-code tests use to prove `eval:hostile` exits 1 on a real safety violation) depends on this exact bug to produce its one I8 violation. Any fix to the TOCTOU must be accompanied by a new violating fixture that doesn't rely on it.
- The fuzz generator (`src/fuzz/generate.ts`) never sets `dailyRateLimit` and never issues more than three submits, specifically so a fuzz run cannot trip this known gap and turn CI permanently red on a bug that isn't a regression. That constraint must be preserved; widening either dimension needs this ADR revisited first.
- I8 (`src/oracles/rate-limit.ts`) must never be weakened to count only what the SUT itself reports as completed through some other channel — it already counts from the harness's own observed intent views, which is what makes it able to catch this bug at all. Weakening it to trust a SUT-echoed count would make it blind to the very thing this ADR documents.
- `limits-daily-rate-limit-01` (`src/corpus/`), which interleaves real syncs, remains the clean counterpart proving the guardrail works correctly when used as intended. It is not evidence against this finding; it is evidence for the boundary of it.
- The README's Findings section states this bug's disposition as "accepted risk, see ADR-0019" rather than "(open)".
- Revisit trigger: if `agent-orchestrator`'s intent or policy layer is touched for any other reason, and especially if `IntentRepository.countCompletedSince`, `SubmitIntent`, or `dailyRateLimit` itself changes shape, re-examine whether this ADR's acceptance still holds or whether the touch is an opportunity to fix it properly behind its own ADR in that package.
