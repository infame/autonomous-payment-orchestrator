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

**Resolution (2026-09-19, `chore/durable-ledger-readme-service-count`):** the
fix landed as a list-not-a-count rewrite of
`packages/durable-ledger/README.md:620` ("This now starts `postgres`,
`pay-core`, `inngest` ..., `durable-ledger`, and `agent-orchestrator`"). One
counting site survives: `packages/agent-orchestrator/README.md:788` still
says "all five services — ...", so a 6th compose service makes *that* line
false. Standing grep before approving any `docker-compose.yml` service
add/remove: `grep -rn "all (four|five|six) services|starts all" packages/*/README.md -E`.
Also: `packages/durable-ledger/README.md` fails `prettier --check` on `main`
already (`*emphasis*` vs `_emphasis_` throughout) — do not charge that to a
doc branch that only edits a couple of lines; see [[repo-lint-not-wired]].

**Use-case counts are a fourth counting site (2026-09-19,
`feat/agent-orchestrator-auto-approve`):** adding a 7th `app/*` use-case made
`packages/agent-orchestrator/README.md` carry the number **five** times, and
the branch updated only three of them. Standing grep before approving any
`src/app/*.ts` addition:
`grep -nE "all (five|six|seven) use-cases|None of the (five|six|seven) use-cases|(five|six|seven) deps" packages/agent-orchestrator/README.md`.
The sites are: `## Status` numbered item 8 ("wires all six use-cases behind
real routes" — ~line 63), the ADR-0014 scoping paragraph ("None of the six
use-cases above scope by caller/customer" — ~line 255), the `## HTTP
interface` intro, the `/healthz` "touches none of the N deps" line, and
`app.test.ts`'s matching test title. The scoping paragraph is the one that
actually matters: it is a *safety* claim ("every id-addressed route compares
`X-Customer-Id` against the stored `Intent.customerId` before calling any of
these use-cases"), and a use-case whose call site deliberately skips that
check must be named there, not only in a separate paragraph lower down.

**Renaming a README section breaks ADR cross-references (same branch):** ADRs
in `docs/adr/` cite README sections *by title* ("see the README's 'Known
limitation' on `Intent.autoApprove` having no production caller",
`0014-customer-scoping-without-authentication.md:116`). Slice 3 replaced that
exact README heading and left the ADR pointing at nothing. **When a docs slice
removes or renames a bold/`##` section title, grep `docs/` and every
`packages/*/README.md` for the old title string before approving.** Related:
an ADR Consequences bullet written as a forward-looking MUST ("if a future
change wires auto-approve into `SubmitIntent`, that same change MUST add a
client-supplied `Idempotency-Key`") is discharged the moment that change
lands — the house-correct fix is a dated one-line `**Update (YYYY-MM-DD):**
satisfied by ADR-00NN` under the bullet, not a supersession (the ADR itself is
still in force) and not a separate follow-up branch (the same docs slice
created the staleness).

**The `mapError` table is a FIFTH enumeration site (2026-09-19,
`feat/agent-orchestrator-auto-approve` fix commit):** `agent-orchestrator`'s
README carries a full row-per-error-class table restating
`adapters/http/server-error-mapper.ts` (`## Error mapping`, ~line 349),
plus a prose paragraph right under it naming which rows are "currently
unreachable in practice" (~line 390). A commit that adds a new error class
*and* an explicit mapper case (here `IntentDerivationCollisionError`, folded
into the `InvalidProposalError, IntentAlreadyExistsError | 500 |
internal_error` row's class list) updated the mapper's own JSDoc from "two
subclasses" to "three" but left both README sites at two. Standing check
when a diff touches `server-error-mapper.ts`:
`grep -n "InvalidProposalError\|internal_error" packages/*/README.md` and
confirm every class named in a `mapError` `instanceof` branch appears in the
table. Same rule applies to the "unreachable in practice" prose — a new
should-be-unreachable class belongs there too.

**Quoting a README section in an ADR: match character-for-character (2026-09-19,
`feat/agent-orchestrator-auto-approve` doc-polish commit):** `agent-orchestrator`'s
README "sections" are often bold paragraphs, not `##` headings, and several end
with a trailing period inside the bold (`**Auto-approve: a policy \`allow\`
verdict's route out of \`proposed\`.**`, README:532). An ADR `**Update:**` note
that quotes the title without that period is a grep miss for the next person.
When reviewing an ADR↔README cross-reference, do not eyeball it: `grep -n` the
quoted string in the README and confirm it hits.
