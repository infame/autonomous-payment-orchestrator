---
name: feature
description: Full team pipeline with scoped planning, implementation, verification, and independent reviews.
---

Coordinate $ARGUMENTS using AGENTS.md shared branch, handoff, verification, and review protocols.

1. Inspect branch/status and establish the task branch without disturbing existing work.
2. Delegate planning to architect for non-trivial work. A coordinator may supply a compact plan only for a small, bounded change with no runtime behavior, API/schema, dependency, security boundary, or architectural change; name affected paths, steps, and checks. Otherwise pass the task and relevant context to architect. For multi-step package work, approve one plan covering the package and its slices. Resolve design-changing ambiguities, summarize the plan briefly, then proceed.
3. Delegate the complete approved plan to one implementer on one package branch. Keep that implementer and plan across slices; resume the same agent for continuations and fixes instead of restarting the pipeline. The implementer commits progress and runs relevant step checks. When the complete package is committed, delegate final verification once to test-runner, reusing valid step evidence. On failure, return the exact failure to the implementer; after two unsuccessful fix attempts, stop with unresolved blockers.
4. After final verification, freeze the complete committed package scope and run reviewer and security-reviewer independently in parallel using the shared protocol. Their first final review examines the full package diff. Fix every blocking finding, including plan omissions; rerun affected checks and both reviews. Otherwise do not repeat reviews for nonblocking advice. An intermediate independent review gate is allowed only when the approved plan explicitly identifies a separately reviewable critical boundary involving payments, security, authentication, persistence, schema, migrations, or an external API contract; it never replaces this final gate. After three final review rounds, stop with unresolved blockers rather than approve.
5. Apply the shared pre-approval checks, then run the approval script only with both matching APPROVEs. Report changed paths, verification, review rounds/fixes, and remaining advice. Land only when authorized and after repeating pre-landing checks; otherwise report readiness.

Keep orchestration concise; do not repeat full logs or ask each agent to rediscover established facts. Independent reviewers must form their own verdicts before seeing the other reviewer's conclusions.
