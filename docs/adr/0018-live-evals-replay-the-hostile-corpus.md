# 18. Live evals replay the hostile corpus; no `llm: {mode: "live"}` scenario field

Date: 2026-09-21

## Status

Accepted

## Context

`docs/todo/04-agent-evals.md` §7 sketches live mode with a per-scenario `llm` union that gains a third arm — `{ mode: "live" }` — alongside the existing `script`/`mock` arms (spec §3's excerpt: `| { mode: "live" }`). Under that sketch, a scenario file itself would declare whether it wants to run against the real vendor model, and the corpus loader/schema (`scenario.ts`) would need to accept and validate that arm.

`@apo/agent-evals`'s existing hostile pipeline (`SuiteEntry` -> `runCorpusScenario` -> `runScenario`) already threads an `LlmClient` through one seam: `CorpusRunOverrides.llm` (added for a different reason — letting a test inject a fake client without touching `Scenario`). Once that seam existed, replaying live mode through it, rather than through a new schema field, was the smaller and more uniform change.

## Decision

Live mode (`eval:live`, step 7) does NOT add `llm: {mode: "live"}` to the `Scenario` schema. Instead, `RunSuiteOptions.llm` (`eval-run.ts`) — when set — REPLACES every entry's own `script`/`mock` client outright, for the whole suite, for the duration of one `runCli` invocation. `scenario.ts`'s own comment ("`llm.mode: 'live'` is deliberately absent: live mode arrives with the CLI") already anticipated this file, not the per-scenario field.

Consequences of the substitution, not the sketch:

- Every corpus scenario is eligible for a live replay with zero schema or corpus-file changes — `--category`/`--only` narrow WHICH scenarios run, not which ones are "live-shaped".
- A scenario's own `llm` block becomes dead data for the duration of a live run (never read: `runCorpusScenario` skips `buildLlmClient(s.llm)` entirely when an override is present) — this is a property of the CLI's call, not something visible in the corpus file itself. A reviewer reading a corpus JSON file cannot tell live mode exists from that file alone; `scenario.ts`'s header and this ADR are the pointers.
- `k` (interleaved passes) and a `--category`/`--only` selection are CLI-level concepts with no scenario-file equivalent — the spec's own per-scenario sketch had no natural home for either.
- The hostile suite's invariant oracles and expectation checks run unmodified over live outcomes. Expectation failures need two separate interpretations: structural loss of script-only hostility, and model variance against text that is itself hostile. For example, `injection-amount-fabricated-01`, `injection-merchant-swap-01`, `limits-currency-not-allowlisted-01`, and `limits-currency-zero-decimal-jpy-01` all use benign text ("Pay $120 to acme for invoice 42"); their hostile proposals exist only in the replaced script. Live replay no longer deliberately exercises those attacks. This does not imply that every model inevitably fails their expectations. Investigate safety-invariant violations regardless of expectation calibration.
- `computeMetrics(outcomes, mode)` unconditionally returns `guardrailCatchRate: null` for suite mode `live`, before inspecting scenario `llm.mode`. Scenario metadata can still say `script` after client substitution, so it cannot establish that a scripted unsafe proposal was exercised. Markdown renders `n/a`.

Rejected alternative: implement the spec's `llm: {mode: "live"}` sketch literally (a corpus author opts a specific scenario into live replay). Rejected because: it requires a schema change and a loader change for a mode the corpus itself has no way to meaningfully validate (there is nothing to check ahead of time — the model's behaviour is exactly what's being measured); it does not compose with `k` (would a scenario run its OTHER `llm` arm zero times, or `k` times, when passes are requested?); and it would make "does this scenario ever hit a real vendor" a property scattered across corpus files rather than a single, auditable CLI-level switch (`--mode live`) that is easy to keep out of the default `eval:hostile`/CI path.

## Consequences

- `docs/todo/04-agent-evals.md` §7's `{ mode: "live" }` sketch is superseded by this ADR for this repo; the local-only, untracked spec document is not edited (same policy other ADRs in this package follow for that file).
- Any future scenario-level knob for live mode (e.g. "never replay this one scenario live" — a scenario whose text is deliberately huge, expensive, or flaky under a real model) would need a NEW mechanism (e.g. a `liveExcluded` corpus-level flag), not a repurposing of `llm.mode`, since `llm.mode` continues to mean "the fixed hostile-mode client" and is ignored entirely once a live override is in effect.
- `RunSuiteOptions.llm`/`CorpusRunOverrides.llm` are now dual-purpose (test seam AND live mode's one substitution point) — a future change to either must consider both callers.
