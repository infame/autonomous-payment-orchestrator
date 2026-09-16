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
