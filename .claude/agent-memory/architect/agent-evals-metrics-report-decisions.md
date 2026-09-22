---
name: agent-evals-metrics-report-decisions
description: Design constraints for agent-evals step 5 (metrics, report, eval:hostile CLI, CI) — why the CLI runs from src via tsx, the known-red TOCTOU scenario as the exit-code fixture, which metrics must trust the SUT's echo, and the report redaction rule.
metadata:
  type: project
---

Decided 2026-09-21 while planning agent-evals step 5
(`docs/todo/04-agent-evals.md` §5/§8/§12.5; the spec is gitignored/local-only).

**The CLI runs TypeScript from `src/` via `tsx`, not `node dist/cli.js`.**
**Why:** `tsc` does not copy `src/corpus/*.json` into `dist`, so a dist-run CLI
needs a copy step in `build` plus a rebuild before every run, and the corpus
loader's default (`new URL("./corpus/", import.meta.url)`) already resolves
correctly under tsx. `tsx@4` is the established sibling pattern
(`db:migrate` in pay-core/durable-ledger/agent-orchestrator) and
`tsx@4.23.13` is already in the pnpm store, so the devDependency installs
offline. **How to apply:** if a dist-run CLI is ever wanted, the copy step and
the "assert non-empty corpus" guard both become load-bearing; until then keep
the guard only.

**pnpm pre-scripts DO run in this repo (verified 2026-09-21, pnpm 11.1.3, no
`.npmrc`)**: `pnpm --filter @apo/agent-evals test` prints
`$ pnpm --filter @apo/agent-orchestrator build` first. **How to apply:** wire
`preeval:hostile` the same way the existing `pretest`/`prelint`/`pretypecheck`
are wired; a CI job then needs no separate `pnpm run build` step.

**The exit-code test needs a REAL violation, and the TOCTOU finding is it.**
A corpus-shaped fixture with three keyed submits, `dailyRateLimit: 2`,
`runStatus: "completed"` and NO `get` steps deterministically produces exactly
one I8 violation while its own `expect` block passes — so a non-zero exit is
provably caused by the safety gate, not by an expectation failure. **Why:**
there is no other way to inject a violation without adding a test-only flag to
production code or mutating an oracle. **How to apply:** if the TOCTOU
behaviour is ever fixed in agent-orchestrator, this fixture and
`src/e2e/limits-rate-limit-toctou.test.ts` flip together — keep them named in
each other's headers.

**`clarify_rate` is the one metric that must read the SUT's echoed
`IntentView.proposal`.** An ambiguous scenario dead-ends at `proposed` with
zero core calls ([[agent-evals-corpus-schema-decisions]]), so an
effects-only definition is always 0 and therefore vacuous. **How to apply:**
say so in the module header; it is informational by spec §5/§11 and must never
gate. Every other metric is computed from the journal + the harness's own
scenario data.

**`guardrail_catch_rate` classifies unsafe proposals with the SUT's exported
pure extractors (`extractGroundedAmounts`, `extractGroundedMerchantTokens`)
plus the observed policy thresholds — never `evaluatePolicy`.** Calling
`evaluatePolicy` would make the metric tautological (the same reasoning that
bans it in oracles, [[agent-evals-oracle-design]]). Denominator counts
scenarios with at least one unsafe SCRIPTED proposal (mock-mode scenarios
excluded: the model is not hostile there); an unconsumed scripted proposal
therefore counts as "caught", a documented generous bias.

**Report redaction rule:** the JSON/Markdown report serializes reason CODES,
numbers, ids, statuses and paths only — never `proposal.reasoning`,
`policyVerdict.detail`, an HTTP body, or the scenario `text`/`description`
(point at `<corpusDir>/<id>.json` instead). `merchantId` IS included (bounded
charset, and it is the evidence in a merchant-swap) but is sanitized when
rendered into Markdown (strip `|`/newlines/control chars, truncate). **Why:**
the artifact is published in CI and linked from the README; a hostile model or
an injection payload must not be able to shape it. A stringify canary test
pins this.

Related: [[agent-evals-harness-decisions]], [[agent-evals-oracle-design]],
[[cross-package-imports-and-build-order]].
