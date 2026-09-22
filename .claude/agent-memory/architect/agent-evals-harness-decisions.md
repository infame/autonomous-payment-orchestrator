---
name: agent-evals-harness-decisions
description: Non-obvious constraints on the agent-evals harness — a hostile LlmClient is bounded by domain validation, the only auto-approve trigger is the Idempotency-Key header, GET doubles as sync, and deriveIntentId is not exported.
metadata:
  type: project
---

Decided/verified 2026-09-20 while planning agent-evals step 2
(`docs/todo/04-agent-evals.md` §12.2).

**"Model is fully compromised" is bounded by `domain/agent-proposal.ts`, and
that is correct.** `ScriptedLlmClient` hands back `AgentProposal` values built
through `paymentProposal()`/`clarifyProposal()`/`declineProposal()`, so it
cannot emit a negative amount, a 4-letter currency, or a 70-char merchantId.
**Why:** the real `AnthropicLlmClient` builds its return value through those
same constructors, so a proposal that fails them can never reach a use-case in
production either. Simulating one would test a path that does not exist.
**How to apply:** don't "strengthen" the hostile model by casting raw literals
past the constructors — the honest worst case is *any domain-valid proposal*,
and that is already enough to reach money movement (see
[[agent-orchestrator-merchant-grounding-gap]]).

**Script exhaustion throws a plain `Error`, deliberately NOT an
`LlmClientError`.** **Why:** `ports/llm-client.ts` declares a closed rejection
set; every member of it is mapped by the SUT into a tidy HTTP response, which
would silently disguise a harness misconfiguration (scenario declared fewer
proposals than the flow consumes) as "the agent failed". A non-member error
escapes to `app.onError` as a 500 and is visible in the HTTP log.
**How to apply:** same reasoning forbids "return a decline after exhaustion" —
that rewrites the scenario instead of reporting the bug.

**Auto-approve — and therefore any core call at all from `POST /intents` — is
reachable ONLY with an `Idempotency-Key` header** (verified: without it, a
grounded, under-threshold, `allow`-verdict intent ends at `proposed` with 0
core calls and is a dead end, since `ApproveIntent` accepts only
`needs_approval`). **How to apply:** any benign/injection scenario that must
reach `executing` has to send the header; a corpus scenario that forgets it
proves nothing.

**`GET /intents/:id` is not a read — it runs `SyncIntentExecution`**, which
calls `getRunStatus` and can transition `executing → completed/failed/
needs_review`. **How to apply:** the runner's final GET is itself an observed
effect; a recording `AgentCoreClient` must journal `getRunStatus` too, and an
oracle counting "core calls" must filter by method, not length.

**`deriveIntentId` is NOT in the orchestrator's public exports** (intentionally
— see `src/index.ts`'s header). **How to apply:** duplicate/idempotency
scenarios must read the id out of the `201` body and reuse it; do not
re-derive it, and do not ask for it to be exported.

**The runner's final `GET /intents/:id` cannot be made to return an error
envelope through the runner's own inputs** (verified 2026-09-20 against
`adapters/http/app.ts` + `app/sync-intent-execution.ts`): the id always comes
from this caller's own 201 so it is a valid UUID and passes the ownership
check; `IntentVersionConflictError` is caught and re-read as 200; and
`SyncIntentExecution` deliberately SWALLOWS every `AgentCoreClientError`
(including `AgentCoreRunNotFoundError`) and returns the stale `executing`
view. **How to apply:** to cover `Observation.finalView === null` on a
non-2xx final GET, inject a `clock` that throws once `getRunStatus` has been
journaled (a throwing clock is the only injectable that reaches the GET path
after the core call) — or skip that branch. Do not "fix" the swallow to make
the test easier.

**`RecordingAgentCoreClient` registers a snapshot for EVERY minted eventId,
duds included**, so `settleRun(dudEventId, …)` succeeds and makes a dud
report `completed` — an ADR-0013-impossible world ("a dud reads `queued`
forever"). **How to apply:** treat it as a documented escape hatch in the
`settleRun` doc comment; rejecting duds would need a separate dud-id set and
is a behavior change to harness support code.

Related: [[cross-package-imports-and-build-order]],
[[agent-orchestrator-http-step8-decisions]].
