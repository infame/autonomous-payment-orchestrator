---
name: review
description: Independent review of a committed task branch against a frozen main SHA.
---

Review $ARGUMENTS using AGENTS.md shared protocol. Inspect branch, HEAD, and status. On `main` or detached HEAD, stop and identify the need for a named task branch; do not approve an ambiguous source. Require intended changes committed and a clean relevant worktree, with unrelated edits isolated.

Establish the plan (or explicitly say no plan was provided and review against task/conventions). Obtain final verification from test-runner, reusing valid evidence and matching check scope to the change. Freeze base/head and delegate the full diff independently to reviewer and security-reviewer in parallel.

Apply the shared report and pre-approval rules. Both matching APPROVEs and valid verification permit the coordinator to run `./scripts/approve.sh <branch>`. Report readiness; landing still requires authorization and repeated checks. If either requests changes, report every blocker, including plan omissions. Do not fix unless authorized. When fixes are authorized, resume the responsible implementer, verify affected changes, and obtain both matching reviews again; delta focus retains full-diff responsibility. Stop after three review rounds with unresolved blockers.
