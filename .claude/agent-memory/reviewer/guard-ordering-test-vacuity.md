---
name: guard-ordering-test-vacuity
description: In this repo, "the guard runs BEFORE the dangerous call" tests are routinely vacuous because the seeded fixture makes the guarded side effect a no-op anyway — check each parameterised route case's seed, and check that each "no side effect" assertion can actually observe the side effect.
metadata:
  type: feedback
---

When a diff adds an ordering guard (ownership check, status check, idempotency
check) that must run *before* an expensive/dangerous call, the test that proves
it is only non-vacuous if the fixture would actually produce the side effect
when the guard is moved after the call. Mentally apply the mutation (move the
guard to the end) and re-run the test in your head.

**Why:** on `feat/agent-orchestrator-http-adapter` (2026-09-19) the
`customer scoping … no side effects` table test covered all four id-addressed
routes with one shared `it.each`, but the `GET /intents/:id` row seeded a
`needs_approval` intent. `SyncIntentExecution` returns early for any
non-`executing` intent (no `getRunStatus`, no write), so
`expect(agentCore.calls).toHaveLength(0)` held whether the ownership check ran
before or after the use-case. The other three rows (approve → agent-core call,
clarify → `llm.reason`, reject → status change) were genuinely non-vacuous.
A shared `it.each` table hides this: one seed per row, but only some rows are
load-bearing.

**How to apply:**
- For every row of a parameterised route table, ask "does this seed reach the
  branch the guard protects?" `sync-intent-execution.ts`, `approve-intent.ts`
  and `answer-clarification.ts` all short-circuit on status, so a fixture in
  the wrong status silently disarms the test.
- Then ask the second question: *can each assertion observe the side effect
  it claims to rule out?* Two traps in this package specifically:
  - **`FIXED_CLOCK` makes `updatedAt`-unchanged assertions vacuous.** Every
    `app.test.ts` use-case is built with `FIXED_CLOCK`, and `Intent.touch`
    just sets `updatedAt = now`, so a write that really happened leaves
    `updatedAt` byte-identical. Only the *status* comparison binds.
  - **`FakeAgentCoreClient.calls` records `startPaymentWorkflow` only** — it
    is never pushed to in `getRunStatus`. So `expect(agentCore.calls)
    .toHaveLength(n)` proves nothing about a `getRunStatus` call; the
    `vi.spyOn(agentCore, "getRunStatus")` assertion is the one that binds.
- Same trap for "conflict/race" tests driven by an armed test-double
  (`ConflictOnDemandRepository.conflictOnNextUpdate`): asserting only the final
  status code passes even if the hook never fired. Ask for an assertion that
  the hook disarmed (`expect(repo.conflictOnNextUpdate).toBe(false)`) or that
  the body shows the *distinguishing* state (the re-read's stale value vs. the
  happy path's fresh one — `InMemoryIntentRepository` `structuredClone`s on
  every read, so the un-written state really is observable).
- Pairs with [[verify-regression-test-against-pre-fix]] (prove the test fails
  against the pre-fix code, and its "positive-control" fallback when mutation
  is blocked) and [[doc-headers-are-load-bearing]]'s "the double hides the
  value" note.
