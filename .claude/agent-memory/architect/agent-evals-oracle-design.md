---
name: agent-evals-oracle-design
description: Design constraints for the agent-evals I1-I8 oracles — effect attribution goes through the HTTP exchange not the SUT's idempotencyKey, Observation must be multi-intent, I1 shares the SUT's own extractor, and the dailyRateLimit TOCTOU that will make I8 legitimately red.
metadata:
  type: project
---

Decided 2026-09-20 while planning agent-evals step 3
(`docs/todo/04-agent-evals.md` §4/§12.3; the spec is gitignored/local-only).

**Core-call → intent attribution must come from the HTTP exchange
(`HttpExchange.coreCallIndexes` + the intent the exchange addressed), never
from `RecordedStartCall.idempotencyKey`.** **Why:** `ApproveIntent`/
`AutoApproveIntent` pass `intent.id` as the durable-ledger idempotency key, so
that field is SUT-controlled output — an oracle that attributes by it would
believe the thing it is judging, and I5 (exactly-once per key) explicitly
treats the key as *data under judgment*. **How to apply:** an unattributable
start call is itself a violation (I4/I5), not something to paper over.

**`Observation` has to carry MULTIPLE intents or I8 and the whole `duplicate`/
`limits` corpus are vacuous.** Each `runScenario` builds a fresh
`createInMemoryAgentOrchestrator`, so `countCompletedSince` is always 0 across
separate runs; the only way to observe more than one intent in one window is a
`submit` step inside one run. Resubmitting the SAME `Idempotency-Key` returns
the SAME intent id (ADR-0015), so the intent list must be deduped by id.
**How to apply:** freeze the multi-intent `Observation` shape BEFORE writing
oracles; hand-built mutant observations are typed against it.

**`dailyRateLimit` is a TOCTOU gate and I8 goes legitimately red — MEASURED
2026-09-21, not a hypothesis.** Probe: one `runScenario`, `policy
.dailyRateLimit: 2`, recorder `runStatus: "completed"`, three keyed submits
and NO intermediate `get` steps → all three auto-approve (each sees
`countCompletedSince` = 0), the runner's trailing GETs sync all three, and
I8 reports exactly one violation, `3 completed intents exceed the daily rate
limit 2`. Insert a `get` between the submits and the third submit is instead
rejected with `daily_rate_limit_exceeded` (I8 subjects 2, green).
`applyPolicy` counts `status === "completed"` at *proposal/auto-approve* time,
but an intent only becomes `completed` when a later `GET /intents/:id` syncs
it. So N intents can all pass the gate while in flight and then all complete →
"completed within the window" exceeds `dailyRateLimit`. **Why it matters:** per
the merchant-swap precedent ([[agent-orchestrator-merchant-grounding-gap]]),
an oracle going red is a FINDING in `agent-orchestrator`, not an oracle to
weaken. **How to apply:** do not rewrite I8 as "completions the SUT counted";
record the finding and fix or accept it in an ADR.

**I1 deliberately reuses the SUT's own `extractGroundedAmounts`** (spec §4
mandates it), so it cannot catch a bug *inside* the extractor — it catches
fabricated amounts and text substitution, because the oracle grounds against
the harness's ORIGINAL scenario text, not `intent.text` from the view. Ground
the union of `extractGroundedAmounts(text)` and each accepted clarification
answer SEPARATELY — `evaluatePolicy` unions per-string and concatenating could
invent a literal at the seam. **How to apply:** oracles may import the pure
grounding/config helpers; they must NEVER call `evaluatePolicy` — reimplementing
the verdict would make every oracle tautological.

**`ZERO_DECIMAL_CURRENCIES` is module-private in `policy/rules.ts`** (not
exported), so I6's "2-decimal" half is enforced by calling the exported
`resolvePolicyConfig(observation.policy)` inside a try/catch and flagging a
throw, rather than duplicating the list.

**Every clean-case oracle test must assert `subjects > 0`.** **Why:** an
oracle whose subject filter selects nothing returns zero violations, so a
"clean Observation passes" test is green for the wrong reason — the same
vacuity trap the reviewer flagged on guard-ordering tests. **How to apply:**
give `InvariantResult` a `subjects` count and assert it in the clean case, not
just `violations.length === 0`.

Related: [[agent-evals-harness-decisions]],
[[agent-orchestrator-merchant-grounding-rule]].
