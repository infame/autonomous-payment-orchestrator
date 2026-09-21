---
name: feature
description: Full team pipeline with scoped planning, implementation, verification, and independent reviews.
---

Coordinate $ARGUMENTS using AGENTS.md shared branch, handoff, verification, and review protocols.

1. Inspect branch/status and establish the task branch without disturbing existing work.
2. Delegate planning to architect for non-trivial work. A coordinator may supply a compact plan only for a small, bounded change with no runtime behavior, API/schema, dependency, security boundary, or architectural change; name affected paths, steps, and checks. Otherwise pass the task and relevant context to architect. Resolve design-changing ambiguities, summarize the plan briefly, then proceed.
3. Delegate the complete approved plan to implementer. Resume that agent for fixes. Delegate final verification to test-runner, reusing valid step evidence. On failure, return the exact failure to implementer; after two unsuccessful fix attempts, stop with unresolved blockers.
4. Freeze committed scope and run reviewer and security-reviewer independently in parallel using the shared protocol. The first review examines the full diff. Fix every blocking finding, including plan omissions; rerun affected checks and both reviews. After three review rounds, stop with unresolved blockers rather than approve. Nonblocking advice does not require another round.
5. Apply the shared pre-approval checks, then run the approval script only with both matching APPROVEs. Report changed paths, verification, review rounds/fixes, and remaining advice. Land only when authorized and after repeating pre-landing checks; otherwise report readiness.

Keep orchestration concise; do not repeat full logs or ask each agent to rediscover established facts. Independent reviewers must form their own verdicts before seeing the other reviewer's conclusions.
