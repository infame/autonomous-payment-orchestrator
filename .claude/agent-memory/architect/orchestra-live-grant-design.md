---
name: orchestra-live-grant-design
description: Why 00-overview §5's gated live-LLM grant needs a separate orchestra gateway plus a SECOND agent-orchestrator instance, rather than any per-request switch — LLM_MODE is boot-time and unfixable without reopening a done package.
metadata:
  type: project
---

Decided 2026-09-22 while designing `packages/orchestra` (05).

**`LLM_MODE` is a single boot-time, process-wide env var, and there is no
per-request seam anywhere behind it.**
**Why:** `config.ts` parses `LLM_MODE` once; `composition-root.ts`'s
`createAgentOrchestrator` calls `createLlmClient(options.llm)` ONCE and hands
the single resulting `LlmClient` to `buildApp`, which passes it into the
`SubmitIntent` and `AnswerClarification` constructors. Nothing downstream of
that ever re-reads a mode. `POST /intents` also accepts no
`paymentMethodToken` (`server-schemas.ts`'s `SubmitIntentBody` is
`SubmitIntentCommand.omit({customerId, idempotencyKey})`, and the command has
no such field), so the same "server-wide only" property holds for the
simulator token.
**How to apply:** any design that wants per-session `live` must either run a
second process already booted in live mode, or reopen agent-orchestrator's
app layer. Prefer the former.

**Chosen shape: orchestra is a gateway service; compose gains a second,
host-unpublished `agent-orchestrator-live` instance.** The gateway is the
only thing the public hits; it validates the signed grant cookie and reverse
-proxies to the mock instance by default or the live instance for a granted
session. Both instances share the same Postgres `agent` schema, so an intent
submitted in mock mode is still readable/clarifiable through the live one.

**The budget backstop is exactly countable at the gateway.** Only two routes
are LLM-capable — `POST /intents` and `POST /intents/:id/clarify`;
`approve`/`reject`/`GET` are not. The gateway claims budget before forwarding,
so its counter is an exact count of attempts to those two routes and a
conservative upper bound on actual `LlmClient.reason()` inference calls. This
is what makes the gateway-side budget honest; re-verify it if
agent-orchestrator ever adds a third LLM-capable route.

**Rejected: a per-request `X-Llm-Mode` header honored on a signed grant.**
It would force agent-orchestrator to verify a grant signature, i.e. become an
auth component — which ADR-0014 explicitly says it is not ("`X-Customer-Id`
is a bare, unsigned, trivially-spoofable header... there is no token, no
session") — and would thread a mode selector through two already-tested
use-cases.

**A grant's remaining-call counter is real state.** An in-memory Map is NOT a
budget backstop under Fly.io scale-to-zero: every wake resets the counter and
the cap becomes unbounded across restarts. Put it in Postgres, in orchestra's
OWN Drizzle schema — never the shared `drizzle.__drizzle_migrations` table
(see [[drizzle-shared-database-migrations]]).

Related: [[orchestra-demo-reachability]],
[[agent-orchestrator-http-step8-decisions]], [[compose-secret-env-passthrough]].
