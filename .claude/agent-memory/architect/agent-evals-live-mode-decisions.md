---
name: agent-evals-live-mode-decisions
description: Design constraints for agent-evals step 7 (live mode) — why agent-evals needs no Anthropic SDK dependency, why live ignores each scenario's `llm` field, the measured budget math, and the repo facts that decide where a live report can be written.
metadata:
  type: project
---

Decided 2026-09-21 while planning agent-evals step 7
(`docs/todo/04-agent-evals.md` §7/§12.7; the spec is gitignored/local-only).

**agent-evals must build its live client through the orchestrator's exported
`createLlmClient({mode:"live", apiKey, model, …})`, NOT by importing
`@anthropic-ai/sdk` itself.** **Why:** that function already does the one
security-relevant thing — it passes `{create: (p,o) => client.messages
.create(p,o)}` so the SDK's `Messages` resource (which back-references the
client and therefore the key) never lands in the object graph — and
`composition-root.test.ts` already pins both that closure wiring and a
key-leak canary with a circular-safe stringify. Adding the SDK as a direct
dependency of agent-evals would let a future edit construct `new Anthropic()`
here and silently reacquire the ambient-credential fallback documented in
[[anthropic-sdk-constraints]]. **How to apply:** agent-evals' own canary test
should prove the *report/stdout* never carries the key (and that the factory
actually received it, or the test is vacuous) — not re-test the adapter.
`FakeAnthropicMessages` is deliberately NOT exported from the orchestrator's
`index.ts`; do not ask for it. Tests inject a fake `LlmClient` instead.

**Live mode substitutes the model for the WHOLE corpus and ignores each
scenario's `llm` field; `llm.mode: "live"` is NOT added to the scenario
schema** (against spec §3's sketch). **Why:** a self-selecting live scenario
would be unrunnable in the gating hostile run, and splitting the corpus into
two disjoint sets makes "the real model on the same adversarial inputs"
uncomparable to the hostile baseline. The scenario's `text`/`customerId`/
`policy`/`steps`/`idempotencyKey` still drive the run — only the proposal
source changes. **How to apply:** `expect` blocks were authored against the
scripted hostile model, so in live they are informational only (they feed
pass@k) and must never gate.

**Budget math, measured against the code 2026-09-21:** one `reason()` call per
submit that reaches the use-case plus one per accepted clarify answer; a
same-`Idempotency-Key` resubmit costs ZERO calls because `SubmitIntent`'s
`repo.findById(deriveIntentId(...))` pre-check returns before `llm.reason`.
The 28-scenario corpus is therefore ~40 live calls per k-pass, so
`MAX_LIVE_CALLS` 100 comfortably fits k=1 and not k=3. **How to apply:** k
passes must be INTERLEAVED (pass 0 over every scenario, then pass 1), so a
budget stop leaves full coverage at lower k instead of complete data for the
first few scenarios.

**Budget is counted BEFORE delegating, and `LiveBudgetExhaustedError` must not
be an `LlmClientError`** — same reasoning as `ScriptExhaustedError`
([[agent-evals-harness-decisions]]): a member of the port's closed rejection
set gets laundered by `server-error-mapper.ts` into a tidy "agent failed"
response. Counting before the call is deliberate: a timed-out or 429'd call
may still have been billed.

**Repo facts that shape the plumbing (verified, easy to miss):**
`report/write.ts`'s `BASELINE_PATTERNS` already contains a `live` entry, so
baseline discovery is mode-scoped for free. `packages/agent-evals/reports/` is
gitignored, so the DoD's "one real run committed as an example" needs a
different directory (`--out examples`), not a `.gitignore` negation.
`report/diff.ts` keys scenarios by id in a `Map`, so k>1 silently keeps only
the last run — fold duplicates with `ok &&= s.ok` when adding k.

Related: [[agent-evals-metrics-report-decisions]],
[[agent-evals-fuzz-decisions]], [[config-zod-superrefine-constraints]].
