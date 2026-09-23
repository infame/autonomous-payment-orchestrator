# claude-team boilerplate

Multi-agent pipeline for Claude Code: architect → implementer → test-runner → two reviewers → loop until approved → report. Work happens on branches; commits there are free. Squash-merging into `main` is physically blocked by a git hook until the branch's diff is approved — the hook sees the actual ref update, not the command text, so wrappers/aliases/`--no-verify` don't bypass it (the only bypass is explicitly disabling the git hooks themselves — that's caught separately by the text-level PreToolUse layer).

## Setup

```bash
cp -r .claude .githooks scripts CLAUDE.md /path/to/your/repo/
cat .gitignore.append >> /path/to/your/repo/.gitignore
cd /path/to/your/repo && chmod +x scripts/*.sh .githooks/*
cd /path/to/your/repo && git config core.hooksPath .githooks
```

Requires `jq`. `git config core.hooksPath .githooks` is a required step — without it `.githooks/reference-transaction` isn't wired up and squash-merging into `main` isn't gated by anything; run it once per clone (it isn't committed, `core.hooksPath` lives in local `.git/config`). This exact command contains the text `core.hooksPath` and so gets caught by the guard pattern in `scripts/guard-commit.sh` (it doesn't distinguish enabling hooks from disabling them) — run it from a plain terminal directly, not by asking the agent to run it as a bash command. Fill in the "Project conventions" section in `CLAUDE.md` — subagents read it at startup.

If `.claude/agents/` didn't exist before the session started — restart `claude`.

## Usage

```
/feature add idempotency-key support to POST /payments
/review                       # review a branch before squash-merging into main
@architect ...                # any role can be invoked directly
```

## What's where

| File | Role |
|---|---|
| `agents/architect.md` | planning, read-only, opus, project memory |
| `agents/implementer.md` | code + tests, inherits the session model, commits freely on the feature branch but never touches `main` |
| `agents/reviewer.md` | review, read-only, project memory, strict verdict format |
| `agents/security-reviewer.md` | security review, read-only |
| `agents/test-runner.md` | haiku, runs typecheck/lint/tests, returns only failures |
| `agents/product.md` | PM: hypotheses from `PRODUCT.md` + code + issues, specs from approved ones; project memory, learns from your scores |
| `skills/product/SKILL.md` | `/product` — hypothesis cards → you score 1–5 → logged in PRODUCT.md |
| `skills/spec/SKILL.md` | `/spec H3` — hypothesis → issue with acceptance criteria and the `agent-ready` label |
| `PRODUCT.md` | The single source of product truth for agents. Vision, metrics, roadmap, Rejected, hypothesis log |
| `skills/feature/SKILL.md` | the pipeline itself — orchestration and iteration limits |
| `skills/review/SKILL.md` | branch review without the pipeline |
| `.githooks/reference-transaction` | a real git hook (`core.hooksPath`), not text pattern-matching: sees any update to `refs/heads/main` — a normal commit, cherry-pick, rebase, revert, `branch -f`, `update-ref`, anything. `main` may only advance by one commit whose diff against the current `main` matches, byte for byte, the approved diff of an approved branch; the marker is consumed only after the transaction genuinely succeeds |
| `scripts/guard-commit.sh` | PreToolUse hook, light ergonomics: blocks `--no-verify`/`--force`/`reset --hard` everywhere. Doesn't gate `main` — `.githooks/reference-transaction` does that |
| `scripts/approve.sh <branch>` | records the branch's SHA as approved in `.claude/.merge-approved`; `.githooks/reference-transaction` reads and one-shot-consumes this file |
| `scripts/post-edit.sh` | PostToolUse: prettier + eslint on the changed file |
| `settings.json` | hooks, allow/deny, subagent nesting depth |

## Roles: who reports to whom

Two role groups, and they don't mix:

- **Product loop** (`product`): what to build. Input — `PRODUCT.md`, signals, code. Output — hypotheses and specs. The human is the judge here: the agent generates, you score.
- **Engineering loop** (`architect → implementer → test-runner → reviewer + security-reviewer`): how to build it. Input — an issue with a spec. Output — a PR.

There's deliberately no separate "project manager / task manager" role: orchestration is the `/feature` skill (ordering, iteration limits) and the dispatcher (which task to pick up). Making it an agent would just add another layer of judgment between you and the work, with no new information.

Verdict precedence when they disagree: security-reviewer > reviewer > test-runner > implementer. No numeric weights — at this scale they wouldn't add anything, and comparing configurations is a job for an eval harness.

## The whole loop

```
/product  →  you score  →  /spec H<n>  →  issue [agent-ready]  →  /feature or dispatcher  →  PR  →  you merge
```

## What to tune for yourself

- Models: `model:` in the frontmatter. `fable` for the architect/review, if available.
- `isolation: worktree` for the implementer — if you want it to work in a separate repo copy. Off by default, so reviewers see the diff in the same checkout.
- Iteration limits — in `skills/feature/SKILL.md` (2 attempts on tests, 3 review rounds).
- Commands in `post-edit.sh` and `test-runner.md` — tune for your own package.json.
- `permissions.allow` — extend it for your own commands so subagents don't ask for permission.
- Want the reviewer to delegate checking each finding itself — give it `Agent` back in tools (currently cut, so it stays strictly read-only).

## Known limitations

- Approval is pinned to the branch tip at `scripts/approve.sh <branch>` time: any content change on the branch afterwards (even a formatting fixup) invalidates it and needs a fresh `/review`. This is intentional.
- This is a guardrail against a coordinating agent reflexively skipping the branch workflow, not a hardened boundary against one deliberately defeating it — the marker file and the gate scripts themselves are plain files a Bash-capable agent could still overwrite directly, and raw writes into `.git/refs` bypass the ref-store API (and the `reference-transaction` hook) entirely.
- Fast-forwarding `main` from a remote is blocked, since it isn't a single approved commit. No remote is configured in this repo, so it's latent; wiring one up needs an exception for a ref already reachable from `refs/remotes/*`.
- Subagents don't see the main session's conversation — all context has to go into the delegating message. `/feature` does this; for manual `@`-invocations, pass it yourself.
- If the session is in `bypassPermissions` or `auto`, subagents' `permissionMode` is ignored — the hooks still run.
