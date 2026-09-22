---
name: repo-lint-wired
description: ESLint flat config + prettier are now real in this repo, but prettier formatting is not enforced repo-wide, so edits cause drive-by reformat churn.
metadata:
  type: project
---

Lint is wired as of the 2026-09-03 hygiene+eslint commit: `eslint.config.js`
(flat, `typescript-eslint` `recommendedTypeChecked` via `projectService`),
root `lint: "pnpm -r lint"`, `packages/pay-core` `lint: "eslint src"`, and
`scripts/*.sh` now carry the exec bit so the PostToolUse hook actually runs.

Caveats to carry into future reviews:

- Prettier has **no config file**; root `format`/`format:check` scripts now exist
  (`prettier --write|--check .`) but nothing runs them, and `prettier --check .`
  still fails on **53 tracked files** (re-measured 2026-09-20).
  `scripts/post-edit.sh` runs `prettier --write` on each edited file, so any edit to
  an unformatted file drags unrelated reformatting into the diff. Expect this churn
  and don't mistake it for intentional change; suggest a one-shot repo-wide format.
- `scripts/post-edit.sh` is **advisory only**: `npx --no-install`, every command
  `|| true`, `exit 0`, and only `*.ts|*.tsx|*.js|*.mjs` are matched (markdown is
  untouched). `CLAUDE.md`'s claim that it "now actually enforces" lint is wrong —
  don't repeat it, and flag it if a diff restates it (see
  [[dual-instruction-sets-codex-claude]]).
- Markdown is in that unformatted set: `packages/agent-orchestrator/README.md`
  fails `prettier --check` **already on `main`** (2026-09-16). Don't flag
  prettier deltas in a README-only diff — diff the file against its own
  `prettier` output and check whether the offending hunks predate the branch
  before calling formatting a finding.
- `eslint`/`prettier`/`typescript-eslint` are declared **only** in the root
  `package.json`, yet consumed by a package-level script. It resolves because
  pnpm puts the workspace-root `.bin` on PATH — fragile if a package is ever
  extracted.

**Why:** my earlier memory said lint was a no-op stub; that is now wrong and
would produce bad review advice.
**How to apply:** lint findings are now real and enforceable; formatting-only
hunks in a diff are usually hook artifacts, not author intent.
- Corollary of the markdown point above: because `post-edit.sh` never touches
  `*.md`, a branch CAN newly break prettier on a README that was clean on
  `main`. Measured 2026-09-22 on `feat/agent-evals-dod-8`:
  `packages/agent-evals/README.md` was clean on `main` and went dirty solely
  from a hand-written, un-padded markdown TABLE (prettier pads cells).
  So: always diff `git show main:<file> | prettier --check -` against the
  branch's — a README prettier failure is only pre-existing if it is
  pre-existing; hand-built tables are the usual new offender.
