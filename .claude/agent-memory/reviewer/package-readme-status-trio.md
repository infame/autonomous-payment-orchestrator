---
name: package-readme-status-trio
description: Each packages/*/README.md carries a Status header + numbered implementation-order list + Roadmap checklist that restate JSDoc contracts; all three must move together each slice.
metadata:
  type: project
---

Every package README here has three coupled sections: a `## Status: steps N-M
of K` header, a numbered "implementation order" list mirroring the local-only
spec's §14, and a `Roadmap` checklist near the bottom. They restate the same
contracts as the file JSDoc headers (see [[doc-headers-are-load-bearing]]), so
a merged slice that touches only one of the three leaves the other two lying.

**Why:** after `feat/agent-orchestrator-submit-get-intent` landed (2026-09-16)
the README still said "steps 1-5 of 9" and "None of steps 6-9 exist yet — no
use-cases"; a follow-up doc-only branch had to fix it.

**How to apply when reviewing:**
- On any slice that adds a file under `src/app`, `src/adapters`, or
  `src/ports`, check all three README sections were updated, not just one.
- README prose is a contract restatement: verify each "exactly N writes",
  "not reachable", "deliberately not persisted", "doesn't scope by X" claim
  against the code, exactly as for a JSDoc header.
- Also grep the README's *other* sections for forward-looking phrases ("once
  the use-case layer exists", "once there's a use-case to test against it") —
  they go stale one slice later than the Status header does.
- In `agent-orchestrator`'s README the trio is really a quartet: the prose
  paragraph right after the numbered list ("Steps 7-9, and the rest of step 6,
  don't exist yet ...") enumerates what's missing and goes stale with the same
  slice. `feat/agent-orchestrator-reject-intent` (2026-09-16) updated all four
  correctly — that is the bar.

**Recurrence (2026-09-17, `feat/agent-orchestrator-http-layer`):** the same
miss, now mid-step. Slice 1 of step 8 added `app/sync-intent-execution.ts`
and updated `src/index.ts`'s header, but left the README saying "Steps 8-9
don't exist yet", "All five exist" in the numbered list, "None of the five
use-cases above scope by caller/customer", and a Roadmap with no line for the
sixth use-case. On a multi-slice branch, ask for the minimal truthful edit in
the slice that introduces the file (counts + Roadmap line + the "don't exist
yet" sentence) rather than letting it ride to the last slice.

**Doc-only "known limitation" notes (2026-09-18,
`chore/agent-orchestrator-document-auto-approve-gap`):** the package has no
"Known limitations" section — such notes get inlined as a bold paragraph at
the end of the topically-nearest section (here, `## The domain model`). Two
checks that apply to that shape:
- If the note ends with "revisit it as its own slice", the `Roadmap`
  checklist at the bottom is the README's index of deferred work and should
  gain an unchecked line. A deferral documented only in prose 300 lines above
  the Roadmap is invisible to whoever plans the next slice.
- A note that asserts something is now *reachable* ("only `needs_approval →
  executing` via `ApproveIntent` is reachable") contradicts older prose that
  still calls the same thing future ("which only a future `ApproveIntent` ...
  can produce", README ~line 82). Grep the README for "a future <Name>" /
  "once ... exists" naming anything the new paragraph treats as existing.
- "`X` has no caller anywhere in this package" is normally false as written:
  tests call it. The accurate claim is "no production caller — only tests
  construct it". Verify with `grep -rn X src | grep -v test`.

**Recurrence, inverted (2026-09-18, `feat/agent-orchestrator-config`, step 8
slice 2):** the README quartet was updated correctly and precisely this time
("`config.ts` now has an `LLM_MODE` switch ... but nothing reads that config
yet"), while the *source headers* that assert the same file's absence were
left behind: `src/index.ts` still said "Not exported because they don't exist
yet: the HTTP/Hono layer, composition root, config, and `main.ts`" and
`adapters/llm/anthropic-llm-client.ts` still said "no composition root, no
config, no `LLM_MODE` switch exist yet". So the check runs both ways: when a
slice adds a file, grep the package's sources for prose asserting that file's
non-existence, not just the README. Cheap recipe:
`grep -rn "don't exist yet\|no config\|not built yet\|LLM_MODE" packages/<pkg>/src --exclude="*.test.ts"`.
The in-repo fix phrasing to copy is `durable-ledger/src/index.ts`'s
"Not exported: `config.ts`/`main.ts` are bootstrap-only".

**Cross-package drift, compose edition (2026-09-19,
`chore/agent-orchestrator-docker-ci`):** the trio rule extends past the
package's own README. Each package's `### Docker` section opens with a
literal service count — "This now starts all four services — `postgres`,
`pay-core`, `inngest`, and `durable-ledger`"
(`packages/durable-ledger/README.md:620`). Adding a 5th compose service in
`agent-orchestrator`'s branch made that sentence false, and the branch only
updated its own README. **When a diff adds or removes a `docker-compose.yml`
service, grep every `packages/*/README.md` for `N services` / the explicit
service list**: `grep -rn "starts all .* services" packages/*/README.md`.
`pay-core`'s equivalent section is phrased without a count ("Postgres,
boot-time migrations, and the `pay-core` HTTP service") and does not drift —
that phrasing is the one to prefer when suggesting a fix.
