# Codex team workflow

Codex instructions live here, in `.agents/skills/`, and in `.codex/agents/`. `.claude` is not Codex instruction authority; existing shared gate scripts still use `.claude` marker files. Do not edit or bypass scripts, hooks, markers, or model settings to satisfy a task.

- Work on `feat/<slug>`, `fix/<slug>`, or `chore/<slug>` branches from `main`; commit freely there. Inspect branch, HEAD, and `git status --short` first. Reuse only a branch whose changes belong to this task. From `main` create a task branch; from an unrelated branch or detached HEAD create an isolated worktree/branch from `main`. Preserve existing edits; never silently stash, discard, stage, or carry unrelated work into the task. Isolate dirty unrelated work before proceeding.
- Use `/feature` for non-trivial changes and `/review` for changes made outside that pipeline. Both require independent reviewer and security-reviewer approval. Only the coordinator approves or performs an explicitly authorized landing; implementers never do either.
- Handoffs contain task, constraints, approved plan, relevant paths, branch/base/head SHAs, and existing verification evidence. Reuse agents for follow-ups; use bounded fresh context where supported instead of copying full transcripts or command logs. Read additional context only when needed. Use available memory; do not require an invented memory file.
- Implementers own step checks; test-runner owns final verification. Evidence records `headSha`, `command`, and `result: PASS|FAIL`, plus relevant environment assumptions. Reuse passing checks only when covered content and environment are unchanged; record why older evidence still applies. Executable changes require relevant tests, typecheck, and lint. Instructions-only changes need structural and workflow checks, not application suites.

## Shared review and landing protocol

1. Review committed changes only. Require a clean relevant worktree, including intended untracked files committed and unrelated edits isolated. Freeze `{branch, baseSha: main SHA, headSha: branch SHA}` and give both independent reviewers the same scope, plan, and verification evidence. Each reviews `git diff <baseSha>...<headSha> --` and necessary surrounding context.
2. Each report starts `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`, includes all three scope fields, and lists every blocking finding explicitly (including plan omissions), separately from nonblocking advice. Either REQUEST_CHANGES blocks approval; neither reviewer can override the other.
3. For fixes, collect every blocker, resume the implementer, and verify changed behavior. Freeze the new scope and obtain both reviews again. Delta-focused follow-ups may reuse prior analysis but remain responsible for the full final diff. A changed base or head invalidates both approvals.
4. Immediately before `./scripts/approve.sh <branch>`, the coordinator verifies both APPROVEs match the frozen scope, both refs are unchanged, the relevant worktree is clean, and verification remains valid. Missing approval or changed refs means no approval: refreeze, reverify as needed, and obtain both reviews. The script records only branch/head; binding approval to base SHA is the coordinator's responsibility.
5. Repeat these checks immediately before an authorized squash landing on `main`. Without landing authorization, report readiness only. Landing uses `git checkout main`, `git merge --squash <branch>`, then `git commit`; resolve any conflict or unexpected content through verification and fresh reviews, not an unreviewed landing.

`.githooks/reference-transaction`, configured through `core.hooksPath`, gates updates to `refs/heads/main`: one single-parent commit from its current tip with the approved diff. `scripts/approve.sh <branch>` writes the shared marker; it does not itself run reviewers. `scripts/guard-commit.sh` is an additional tool pre-check. These are guardrails, not a substitute for the protocol above; never disable or overwrite them.

# Project conventions

- TypeScript strict/ESM, pnpm workspaces, Node.js >=24; `packages/pay-core` uses Zod and Vitest. Consult current package manifests and adapters for implemented integrations.
- Hexagonal layout: domain/app depend on ports; concrete adapters hold vendor integration. Domain never imports vendor SDKs. See `docs/adr/0002-ports-and-adapters.md`.
- Use typed `DomainError` subclasses with `code` from `packages/pay-core/src/domain/errors.ts`. Match existing logging and error-handling patterns; no `any`, `@ts-ignore`, secrets, dead code, or unlinked TODOs.
- Root checks: `pnpm test`, `pnpm run typecheck`, `pnpm run lint`; package scope: `pnpm --filter @apo/pay-core <test|typecheck|lint>`. Lint uses `eslint.config.js` and type-aware project service.
- `scripts/post-edit.sh` provides best-effort formatting/lint feedback for TS/JS files when its Edit/Write hook runs. It exits successfully even when checks fail; it neither enforces verification nor guarantees Codex invocation.

# Product loop

`PRODUCT.md` is product truth. `/product` persists complete, uniquely numbered hypothesis cards before requesting scores; `/spec H<n>` resolves them across sessions and asks for spec approval before creating issues. Retain rejected cards and reasons. Do not implement from either skill.

Keep reports concise: changed paths, evidence, blockers, and next action. When already available, note token/call counts and review rounds to observe workflow cost; do not invent savings or add mandatory instrumentation.
