---
name: verify-regression-test-against-pre-fix
description: On a re-review, prove a new regression test is not vacuous by running it against the pre-fix commit in a detached git worktree — recipe, the guard-hook cleanup gotchas, and the positive-control fallback for when the sandbox blocks mutating a security check.
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
   A plain `cp -R` of the package into the scratchpad also works, but
   `tsconfig.json` does `extends: "../../tsconfig.base.json"` — copy
   `tsconfig.base.json` two levels above the copy or vitest dies in
   `TSConfckParseError` before collecting a single test.
4. Expect exactly the new scenario to fail, and read the failure message —
   it should name the leaked/wrong value, not just "expected X to be Y".
5. Cleanup: `git worktree remove` with the force flag is BLOCKED by
   `scripts/guard-commit.sh` (it blocks that flag anywhere in the command
   text, including inside a heredoc), and recursive deletes prompt. So
   `git checkout --` the copied file, `unlink` the two `node_modules`
   symlinks, then plain `git worktree remove`. See
   [[hook-gate-review-heuristic]].

**When the mutation itself is blocked — use the positive control instead.**
When the regression is "an ownership/auth check was moved after the guarded
call", editing that check to prove the test catches it trips the sandbox's
`Security Weaken` classifier — *even on a throwaway copy in the scratchpad*,
and even via a heredoc'd python rewrite. Do not fight it. Instead find (or
ask for) the *positive-control* test: the same fixture with the **correct**
caller, showing the guarded call really does fire and really does write. If
`correct owner + fixture F ⇒ side effect S` is green, and the new test is
`wrong owner + fixture F ⇒ NOT S`, the ordering is pinned without ever
weakening the check. On 2026-09-19 `app.test.ts`'s
`"executing + a completed run snapshot: 200 status completed"` was exactly
that control for the new wrong-owner GET test.
