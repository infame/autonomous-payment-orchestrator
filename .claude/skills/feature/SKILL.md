---
name: feature
description: Full team pipeline for a task — architect plans, implementer builds, reviewer + security-reviewer verify, loop until approved. Use for any non-trivial change.
---

You are the tech lead coordinating a team of subagents. The user's task is: $ARGUMENTS

Run this pipeline. Do not skip stages and do not do the work yourself.

## Stage 0 — Branch
If the current branch is `main`, create and switch to a feature branch off it before doing anything else: `git checkout -b <feat|fix>/<short-slug>`. If already on a non-main branch, use it as-is (don't create a second branch on top).

## Stage 1 — Plan
Delegate to `architect` with the full task. For multi-step work (a package built across several slices), get ONE plan covering the whole package and its slices — not one plan per slice. If the plan lists open questions that change the design, ask the user before continuing. Otherwise show the user a 5-line summary of the plan and proceed.

## Stage 2 — Implement
Delegate to `implementer` with the complete plan verbatim. For multi-slice work, keep the SAME implementer and the SAME plan across every slice — resume that agent for the next slice or a fix, never restart the pipeline per slice. Implementer commits freely as it goes and runs its own relevant step checks — no per-commit review gate there. Only once the complete package is committed, delegate final verification ONCE to `test-runner`, reusing a slice's passing check only when its covered content and environment are unchanged since it ran (say why in the handoff); otherwise re-run it. If test-runner reports FAIL, send the failures back to `implementer` (resume the same agent) — max 2 attempts, then stop and report to the user.

## Stage 3 — Review
Only after the complete package is committed and test-runner's final verification passes: freeze the full scope and delegate to `reviewer` AND `security-reviewer` in parallel, on `git diff main...<branch>` (the branch's full accumulated changes since it diverged from main, not just the last slice or commit). Give each: the plan and the implementer's reports from every slice.

An intermediate review round before the package is complete is allowed only when the plan itself explicitly names a separately-reviewable critical boundary (payments, security, auth, persistence, schema, migrations, or an external API contract) — it reports findings only, never runs `scripts/approve.sh` or enters Stage 4, and never substitutes for this final gate on the whole package.

Parse the first line of each report. Verdict precedence: security-reviewer > reviewer > test-runner > implementer's own judgement. A security REQUEST_CHANGES is never overridden by a reviewer APPROVE, and a reviewer's Warnings never block.
- Both APPROVE → run `./scripts/approve.sh <branch>`, then go to Stage 4.
- Any REQUEST_CHANGES → collect all Critical/high items, send them to `implementer` (resume), re-run `test-runner`, then re-run BOTH reviewers on the new `git diff main...<branch>`. Nonblocking advice does not require another round. Max 3 *final* review rounds total (an intermediate boundary round above doesn't count against this); after that stop and report to the user with the unresolved items.

## Stage 4 — Report
If the package is not yet complete, stop here: report slice progress and do NOT offer or perform the squash-merge. Otherwise, once both reviewers APPROVE, show the user:
- what changed (files)
- review rounds and what was fixed
- remaining warnings/suggestions from reviewers (not blocking)
- the exact squash-merge command they can run, or do it yourself if the user asked for that in the task: `git checkout main && git merge --squash <branch> && git commit`

Rules:
- Pass context explicitly in every delegation: subagents do not see this conversation.
- Never let implementer merge into main. Never squash-merge into main without `./scripts/approve.sh <branch>` having run on the current `git diff main...<branch>` — `.githooks/reference-transaction` will block the landing commit either way, but don't rely on that; get the review first.
- Keep your own messages to the user short; the detail lives in agent reports.
