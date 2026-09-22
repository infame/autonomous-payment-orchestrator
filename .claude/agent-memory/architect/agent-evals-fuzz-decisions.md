---
name: agent-evals-fuzz-decisions
description: Design constraints for agent-evals step 6 (fuzz/property layer) — why fast-check was rejected, seed+index (not seed+count) as the replay key, why fuzz must never override dailyRateLimit, and why fuzz is excluded from guardrailCatchRate.
metadata:
  type: project
---

Decided 2026-09-21 while planning agent-evals step 6
(`docs/todo/04-agent-evals.md` §6/§9.3/§12.6; the spec is gitignored/local-only).

**fast-check REJECTED in favour of an own ~60-line seeded PRNG**, against the
spec's §9.3 recommendation. **Why:** the fuzz output has to be *`Scenario`
data* that flows through the same `runSuite`/metrics/report pipeline as the
corpus (the CLI, not just vitest, must run it), and the only thing the dep
buys is shrinking — which would have to re-run the SUT (fresh orchestrator +
several HTTP exchanges per case) many times per failure, and per spec §11 a
counterexample is promoted to a *hand-written* corpus scenario anyway, so a
"minimal" one saves little. A generated case is already one text + one script
+ ≤4 steps. **How to apply:** if shrinking is ever wanted, add it as a
vitest-only property test; do not put `fc.sample` on the CLI path, and do not
rely on fast-check's sample stream being index-stable across `numRuns`.

**Replay key is (seed, index), never (seed, count).** Each case's PRNG is
derived as `mix(hash(seed), index)`, so case i is byte-identical regardless of
how many cases the run generated. **Why:** raising `--fuzz-count` must not
renumber every earlier case and invalidate every recorded violation. **How to
apply:** `generateFuzzScenarios(seed, n)[i] === generateFuzzScenario(seed, i)`
is a test, not a comment.

**The fuzz layer must never be able to re-derive the OPEN dailyRateLimit
TOCTOU finding** ([[agent-evals-oracle-design]]): I8 would go red and the
`safety_violations = 0` gate would be permanently failing on a known, accepted
issue. Structural guard: the generator never overrides `dailyRateLimit`
(default 10) and never emits more than 3 submits. **How to apply:** any new
generator dimension has to be checked against the list of *open* findings in
`packages/agent-evals/README.md` before it ships; the fuzz gate is only
meaningful while every red it can produce is a NEW finding.

**Generated scenarios carry a vacuous `expect` block by design** (`terminal:
INTENT_STATUSES`, `coreCalls {0, n}`) — a generator cannot know the right
answer, and the point of §6 is the oracles, not expectations. The anti-vacuity
proof therefore lives elsewhere: aggregate assertions over the default batch
(start calls > 0, ≥1 rejected intent, per-oracle `subjects > 0`), not per
case.

**Fuzz is EXCLUDED from `guardrailCatchRate`.** The script must be
over-provisioned (a `ScriptedLlmClient` running past its end throws and turns
the whole scenario into a harness error), and an unconsumed scripted proposal
counts as "caught" — with fuzz dominating the denominator that documented
generous bias would inflate the headline rate toward 1.
**How to apply:** fuzz reports through its own `byCategory.fuzz` row +
report `fuzz` block instead. `falseRejectRate`/`clarifyRate` key on
benign/ambiguous and are untouched.

**`category: "fuzz"` is added to `ScenarioCategory` but BANNED in the corpus
loader** (`loadCorpus` throws on it). **Why:** generated cases need a category
the metrics table can separate them by, but a dumped fuzz case must not be
droppable into `src/corpus/` unreviewed with its vacuous `expect` block.
Promotion means a real id, category, description and expectations.

**Provenance is a wrapper, not a Scenario field:** `runSuite` takes
`SuiteEntry { scenario, source: {kind:"corpus"} | {kind:"fuzz", seed, index} }`.
A field on `Scenario` would let a corpus JSON file claim to be fuzz; an id
prefix (`fuzz-…`) would be stringly-typed.

**Redaction extends unchanged to fuzz:** a fuzz violation references
seed+index, never the generated text (which is built from injection-shaped
fragments and would otherwise land in a published CI artifact). The seed is
charset-validated (`^[a-z0-9-]{1,32}$`) because it is interpolated into
scenario ids, filenames and Markdown.

Related: [[agent-evals-metrics-report-decisions]],
[[agent-evals-corpus-schema-decisions]], [[agent-evals-harness-decisions]].
