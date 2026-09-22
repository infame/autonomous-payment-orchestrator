---
name: agent-evals-dod-mutation-sweep
description: agent-evals step-8 DoD decisions — why a config override can never turn an oracle red (only a dist mutation can), the I1-I8 guardrail-disable matrix, and the "8 categories" reading of spec §10.
metadata:
  type: project
---

Decided 2026-09-22 while planning agent-evals step 8, the DoD sweep
(`docs/todo/04-agent-evals.md` §10; the spec is gitignored/local-only).

**A scenario-level `policy` override can never make an oracle red — only an
expectation fail.** **Why:** every threshold oracle (I2 hard limit, I4
approval gate, I6 currency, I8 rate limit) judges against
`Observation.policy`, i.e. the SAME resolved config the SUT ran under. Raising
`maxHardLimitAmount` raises it for the oracle too, so the existing meta test
in `corpus.test.ts` proves *scenario* redness (an expectation failure), not
*oracle* redness. **How to apply:** the DoD's "disable the guardrail and watch
it go red" can only be done by mutating the built SUT. Mutate
`packages/agent-orchestrator/dist/**` (gitignored build output — the change is
physically uncommittable and a rebuild restores it), never `src`. Run the one
scenario with `pnpm --filter @apo/agent-evals exec vitest run src/corpus.test.ts
-t "corpus scenario <id>"` — `pnpm exec` skips the `pretest` script, which
rebuilds the orchestrator and would silently erase the mutation and produce a
false green.

**Guardrail → oracle matrix that actually goes red** (measured design, from
reading the SUT 2026-09-22): I1 drop `amountMustBeGrounded` from
`POLICY_RULES`; I2 drop `maxHardLimit` *and* use a scenario with an approve
step (dropping the rule alone only downgrades reject → needs_approval, which
produces no start call at all); I3 delete `approve-intent.ts`'s
`status !== "needs_approval"` guard — `startPaymentWorkflow` runs BEFORE
`intent.approve()`'s domain guard, so the effect lands even though the request
then 500s (this is exactly the danger that file's header warns about); I4 drop
`maxAutoApprove`; I5 replace `deriveIntentId(customerId, key)` with a random
uuid, which is caught ONLY by I5's request-key subject (two intents sharing one
header key), the per-intent checks stay green; I6 drop `currencyAllowed`; I7
delete one of the four `existing.customerId !== customerId` checks in
`adapters/http/app.ts`; I8 drop `dailyRateLimit`.

**Spec §10's "all 8 categories" means §3's 8 TABLE ROWS, not 8 enum values.**
§3's `Scenario.category` union lists exactly seven (`injection` appears twice
in the table: prompt injection and merchant swap), and §10 writes
"по всем 8 категориям **+ fuzz**" — fuzz is additive, not the eighth. The
implemented schema's eighth enum value, `fuzz`, is banned in corpus files by
`loadCorpus`, so a literal "eight curated categories" reading is
unsatisfiable. **How to apply:** step 8 needs no new category — only enough
hand-written scenarios to cross 30, and the count belongs in
`corpus.test.ts`'s threshold, not only in prose.

**The daily-rate-limit TOCTOU is closed as an ADR-accepted risk, not fixed**
(owner decision 2026-09-22, ADR-0019). `agent-orchestrator` is not touched.
Anything that depends on the bug staying open — `src/e2e/limits-rate-limit-toctou.test.ts`'s
`it.fails`/characterization pair, `src/cli-fixtures/violating/`, and the fuzz
generator's "never set `dailyRateLimit`, never submit more than three times"
constraint — flips together if it is ever fixed.

Related: [[agent-evals-corpus-schema-decisions]], [[agent-evals-oracle-design]],
[[agent-evals-fuzz-decisions]].
