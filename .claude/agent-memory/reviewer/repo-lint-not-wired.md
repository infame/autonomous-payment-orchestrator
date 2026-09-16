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

- Prettier has **no config file, no `format`/`format:check` script, and several
  tracked files fail `prettier --check`. `scripts/post-edit.sh` runs
  `prettier --write` on each edited file, so any edit to an unformatted file
  drags unrelated reformatting into the diff. Expect this churn and don't
  mistake it for intentional change; suggest a one-shot repo-wide format.
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
