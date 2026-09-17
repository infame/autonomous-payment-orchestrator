---
name: verify-regression-test-against-pre-fix
description: On a re-review, prove a new regression test is not vacuous by running it against the pre-fix commit in a detached git worktree — recipe, plus the guard-hook gotchas that make cleanup awkward.
metadata:
  type: feedback
---

When a fix commit claims "this new test would have failed against the old
code", do not take it on faith and do not reason it out alone — run it.

**Why:** re-review rounds in this repo land fix commits whose regression test
is one line away from vacuous (a scenario whose input fails an earlier zod/
schema gate never reaches the buggy branch at all, and still passes). Running
the *new* test against the *old* code is the only assertion that proves the
test binds. It also catches the reverse: a test that passes both ways.

**How to apply** (used on `feat/agent-orchestrator-anthropic-llm-client`,
2026-09-17, to prove the `InvalidProposalError` cause-chain leak test —
see [[vendor-sdk-adapter-review]]):

1. `git worktree add <scratchpad>/oldwt <pre-fix-sha>` (detached; never touches
   the branch working tree).
2. Copy ONLY the new test file into the worktree, over the old one.
3. `pnpm exec` / `pnpm --filter` will try `pnpm install` in the worktree and
   die with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Instead symlink the
   repo's root and package `node_modules` into the worktree and invoke the
   binary directly: `<repo>/packages/<pkg>/node_modules/.bin/vitest run <file>`.
4. Expect exactly the new scenario to fail, and read the failure message —
   it should name the leaked/wrong value, not just "expected X to be Y".
5. Cleanup: `git worktree remove` with the force flag is BLOCKED by
   `scripts/guard-commit.sh` (it blocks that flag anywhere in the command
   text, including inside a heredoc), and recursive deletes prompt. So
   `git checkout --` the copied file, `unlink` the two `node_modules`
   symlinks, then plain `git worktree remove`. See
   [[hook-gate-review-heuristic]].
