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

**Third vacuity family — the negative assertion whose input never existed**
(2026-09-20, `chore/review-followups`): a `drops tokens with no letter` test in
`policy/grounding.test.ts` asserts `set.has("-")`, `set.has("_")` and
`set.has("--")` are all `false` against the fixture `"Pay the vendor - $50.00"`
— only the first binds, the other two tokens are absent from the text and would
be `false` under ANY implementation, including the old `DIGITS_ONLY` one. For
every `expect(x.has(v)).toBe(false)` / `not.toContain(v)`, check that `v` is
actually *derivable from the fixture input*; if the input never contained it,
the assertion is decoration. Same move as the seeds above, one level down.

**`[].every(...)` is `true` — the recurring shape in this repo (third sighting,
2026-09-21, `feat/agent-evals-metrics-cli`).** `metrics.ts`'s `clarifyRate` has
`proposed.length > 0 && proposed.every((a) => a === min)`; drop the length guard
and an ambiguous scenario that proposed NOTHING counts as "took the minimum
interpretation". Same shape as `expectations.ts`'s
`actual.length === expected.startAmounts.length` guard (slice 1 of the corpus).
Whenever a diff adds `xs.every(...)` over a list that can legitimately be empty,
look for the length guard and then for the test that kills its removal — in both
sightings the guard was present and correct but no test bound it.
