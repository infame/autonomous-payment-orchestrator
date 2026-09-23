# 20. orchestra gateway and the second orchestrator instance

Date: 2026-09-22

## Status

Accepted

## Context

`docs/todo/00-overview.md` §5 (local-only, not in this repo) requires a public demo that defaults to a free, deterministic `mock` LLM and only ever spends a real Anthropic-backed `live` call behind an admin-issued, signed, TTL+call-capped grant.

`@apo/agent-orchestrator`'s `LLM_MODE` is parsed once by `config.ts` and consumed exactly once by `composition-root.ts`'s `createAgentOrchestrator`, which calls `createLlmClient(options.llm)` a single time and hands the one resulting `LlmClient` into `buildApp`, which threads it into the `SubmitIntent` and `AnswerClarification` constructors. Nothing downstream ever re-reads a mode — there is no per-request seam anywhere behind `LLM_MODE`. `POST /intents` also carries no `paymentMethodToken` field (`server-schemas.ts`'s `SubmitIntentBody` omits it entirely), so the same "server-wide only" property already holds for `pay-core`'s simulator token; `LLM_MODE` is architecturally the same shape.

## Decision

`orchestra` runs a small Hono gateway (`src/adapters/http/gateway-app.ts`) as the only publicly-reachable service, and `docker-compose.yml` gains a SECOND `agent-orchestrator` instance (`agent-orchestrator-live`, `LLM_MODE: live`, unpublished host port, behind compose profile `live`) already booted in live mode. The gateway holds no policy/domain logic of its own: it validates a signed grant cookie, enforces a per-grant and global daily call budget (counted only on the two routes that actually call `LlmClient.reason()` — `POST /intents` and `POST /intents/:id/clarify`), and reverse-proxies `/api/*` to the live instance when a valid, non-exhausted grant is present, or to the mock instance otherwise. Both instances share the same Postgres `agent` schema, so an intent submitted against the mock instance stays fully readable/clarifiable/approvable through the live one and vice versa — there is exactly one `agent.intents` table, never two.

`orchestra` talks to `agent-orchestrator` (and `durable-ledger`, and `pay-core`) over HTTP only, with its own Zod response schemas for whatever it parses — no `workspace:*` dependency on any sibling. [ADR-0016](0016-agent-evals-imports-the-built-orchestrator.md) licensed `agent-evals` to import `agent-orchestrator`'s built `dist` because `agent-evals` is a test harness driving the system under test in-process, not a peer service. `orchestra` is the opposite case: a runnable service in front of another runnable service, exactly the shape [ADR-0005](0005-duplicate-money-across-packages.md) and [ADR-0011](0011-no-third-money-copy.md) describe for `durable-ledger`↔`pay-core` and `agent-orchestrator`↔`durable-ledger`. The "packages talk over HTTP" rule binds it, not the `agent-evals` exception.

### Rejected alternative: a per-request `X-Llm-Mode` header honoured on a signed grant

Instead of a second process, `agent-orchestrator` could read a header, verify an orchestra-issued grant signature itself, and switch `LlmClient` per request. Rejected for two reasons:

1. It would force `agent-orchestrator` to verify a grant signature — i.e. become an auth-adjacent component. [ADR-0014](0014-customer-scoping-without-authentication.md) is explicit that `agent-orchestrator` has no session/token model and that `X-Customer-Id` is "a bare, unsigned, trivially-spoofable header... there is no token, no session, no proof of identity of any kind." Teaching it to verify an HMAC grant would contradict that ADR's stated posture, for a concern (live-LLM budget gating) that belongs entirely to `orchestra`.
2. It would thread a mode selector through two already-tested use-cases (`SubmitIntent`, `AnswerClarification`), each of which currently receives its `LlmClient` once, at construction, from the composition root — turning a boot-time dependency into a per-call one is a real change to a stabilized package's internals for a feature that package's own spec (`00-overview §5`) already assigns to `orchestra`.

A second already-booted process, mediated by a stateless proxy, keeps every existing `agent-orchestrator` file untouched and keeps the entire grant/budget concern inside the one package whose job it is.

## Consequences

- Two `agent-orchestrator` containers run under `docker compose --profile live up`, doubling that package's memory footprint for the loaded feature, but neither needs its own migration run: `agent-orchestrator-live` sets `MIGRATE_ON_BOOT: "false"` since the mock instance already owns migrating the shared `agent` schema — running both with `MIGRATE_ON_BOOT: true` would race two `agent.__drizzle_migrations`-journaled runs against the same schema on cold start.
- `agent-orchestrator-live` MUST stay behind a compose profile, not run by default: `config.ts`'s `superRefine` rejects `LLM_MODE=live` with no `ANTHROPIC_API_KEY`, so an unprofiled live service would crash-loop on every plain `docker compose up` in an environment with no key configured — exactly the default, keyless environment `00-overview §5`'s "mock is the public default" requirement describes.
- The gateway is a second place (besides `agent-orchestrator` itself) that must never log or reflect a customer's intent text, the grant token, or the `X-Admin-Secret`/session cookie — proxy hygiene is enumerated explicitly in `docs/todo/05-orchestra.md §4` and enforced by `gateway-app.test.ts`.
- A grant's remaining-call counter is real state, not an in-memory counter: Fly.io scale-to-zero (`00-overview §7`) means an in-memory Map would reset the budget on every wake. It lives in Postgres, in `orchestra`'s own `orchestra` schema with its own migrations table — never `agent`'s, `ledger`'s, or `public`'s (see `docs/todo/05-orchestra.md §4` and the DB schema contract in the implementation plan).

## Considered and rejected

- **Per-request `X-Llm-Mode` header** — see above.
- **A single `agent-orchestrator` instance with a runtime-mutable config** — rejected: would require a live config-reload mechanism this package has never needed and isn't tested against; strictly more risk than booting a second, already-tested process twice with different env.
- **Giving the gateway a `workspace:*` dependency on `agent-orchestrator` to reuse its Zod schemas** — rejected per ADR-0005/0011's HTTP-only rule for services; `orchestra` defines its own narrow response schemas for exactly the fields it reads, matching how `durable-ledger`'s `pay-core-client.ts` and `agent-orchestrator`'s `durable-ledger-client.ts` each already do this for their own upstream.
