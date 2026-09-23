# @apo/orchestra

Head package (`packages/orchestra`) in the **APO** (Autonomous Payment
Orchestrator) monorepo — a portfolio project. See the [root README](../../README.md)
for the whole system; this package is what ties the other four together: an
end-to-end demo CLI, a small grant-gated gateway into live-LLM mode, and the
project's public front door.

## What it does

- **Demo CLI** (`pnpm --filter @apo/orchestra demo`) — drives the already-running
  docker-compose stack over plain HTTP through three scenarios and prints a
  pass/fail narration for each beat. See "Demo scenarios" below.
- **Gateway** (`src/main.ts`, port 3300) — the only general browser-facing
  service: mediates an admin-gated, HMAC-signed, TTL+call-capped grant into
  live-LLM mode, reverse-proxies `/api/*` to either the mock or the live
  `agent-orchestrator` instance, and serves a minimal server-rendered HTMX
  UI. (A managed Inngest deployment also needs the signed
  `durable-ledger` callback reachable by Inngest's control plane; see the
  deploy runbook.) See
  `docs/adr/0020-orchestra-gateway-and-the-second-orchestrator-instance.md`.

## Browser UI

`GET /` renders the create form. Its `POST /ui/intents` handler translates
the form field to the JSON API wire shape, delegates through this same app's
`/api/*` proxy, and redirects with `303` to `GET /intents/:id`. The detail
page renders the current intent plus only the actions valid for that state:
clarify, approve, or reject. Those forms follow the same UI-to-API path, so
grant selection, live-call budgets, timeouts, and proxy header filtering are
not duplicated in a second implementation. Upstream errors become escaped
HTML while preserving their HTTP failure status.

There is deliberately no intent-list endpoint or list page: the gateway does
not have an upstream list API to call. Navigation is create → one detail page
→ state-specific actions (or back to a new intent), not a dashboard whose
data source does not exist.

## Demo scenarios

```
pnpm --filter @apo/orchestra demo --scenario all
```

| Scenario | What it proves |
|---|---|
| **A — canonical** | Ambiguous invoice → clarify → policy approval gate → approve → durable retry (a simulated `capture` failure, retried by Inngest) → completed, with ledger balance-delta evidence for both the merchant and `acquirer_clearing` accounts. |
| **B — cancellation** | An intent is rejected at the approval gate before any money moves. **This is an honest orchestrator-level `reject`, not durable-ledger's saga compensation** — the saga path is proven correct in-process (`payment-execute-compensation.test.ts` in `@apo/durable-ledger`) but is not reachable through the live stack today (F2, `docs/todo/05-orchestra.md §3`). The narration says this explicitly; it is not dressed up as the saga. |
| **C — guardrail** | An ungrounded amount proposal (one minor unit above the largest amount literally present in the intent text) is rejected outright, independent of magnitude, with zero core calls and no ledger effect. |

Flags: `--scenario a|b|c|all`, `--base-url` (agent-orchestrator, default
`http://localhost:3200`), `--ledger-url` (default `http://localhost:3100`),
`--pay-core-url` (preflight health check only, default `http://localhost:3000`),
`--customer-id`, `--timeout-ms`, `--json`, `--help`.

`DURABLE_LEDGER_SERVICE_SECRET` is required in the CLI environment and is
sent only to durable-ledger's balance endpoint. Use the same value exported
before `docker compose up`; agent-orchestrator uses it independently for
workflow start/status calls.

Exit codes: `0` every requested scenario's beats held; `1` at least one
scenario's own assertion failed; `3` a harness/connection error (a service
unreachable, an unparseable response, a timeout) — deliberately distinct
from `1`, since it says nothing about whether the system under test is
actually broken.

The CLI talks DIRECTLY to each compose port, never through the gateway — the
gateway exists for a public visitor, not a local developer running this CLI.

## Considered and rejected

- **Automating the demo against the real docker-compose stack in CI.**
  Rejected: would need Docker-in-CI, is inherently timing-dependent (Inngest
  retry timing, container boot order), and duplicates what
  `@apo/agent-evals`'s hermetic hostile corpus already gates. The demo
  against the real stack stays a manual runbook step (`docker compose up -d
  --build && pnpm --filter @apo/orchestra demo`), not a CI job.
- **Extending pay-core's simulator grammar to make the saga live-reachable
  (F2).** Rejected for this branch — `pay-core` is a stabilized package;
  reopening its simulator to add a second, post-authorize outcome segment is
  a real change to a "done" package for a demo-narration concern. The gap is
  named instead of quietly patched around.
- **A CDN-hosted htmx.** Rejected — `public/htmx.min.js` is vendored into
  this repo so the demo doesn't depend on an external CDN staying up.

## Grant-gated live mode

See `docs/todo/05-orchestra.md §4` and ADR-0020 for the full grant model.
Summary of what's built:

- `POST /internal/grant` — `X-Admin-Secret`-gated (timing-safe compare), 404
  on any missing/wrong secret (never 401/403 — ADR-0014's existence-oracle
  reasoning), 503 when `AGENT_ORCHESTRATOR_LIVE_URL` isn't configured.
  Mints a Postgres row (`orchestra.live_grants`) and returns an HMAC-signed
  link (`src/grant/token.ts`, `node:crypto` only, no JWT dependency).
- `GET /grant/:token` — verifies signature + expiry, atomically binds the
  grant to the first opener (a second browser opening the same link gets
  404 — binding is one-shot, not idempotent for re-opens), and sets paired
  `apo_grant` and opaque `apo_grant_session` cookies
  (`HttpOnly; Secure; SameSite=Lax; Path=/`). A copied signed token without
  the bound-session cookie is not sufficient to reach live mode.
- `/api/*` — reverse-proxies to the live `agent-orchestrator` instance only
  while a valid, unexpired grant cookie is present; mock otherwise. Budget
  is counted ONLY on the two routes that actually call `LlmClient.reason()`
  (`POST /intents`, `POST /intents/:id/clarify`) via one atomic
  `UPDATE ... WHERE used_calls < max_calls ... RETURNING` — exhaustion
  always returns 429, never a silent downgrade to mock. A global daily
  backstop (`orchestra.live_budget`) is claimed alongside the per-grant one.
- Proxy hygiene: `X-Admin-Secret` and `Cookie` are never forwarded upstream;
  `X-Customer-Id` is always the gateway's own per-browser session cookie,
  never trusted from the incoming request; `/internal/*` is never proxied.
- Own Drizzle schema (`orchestra.*`), own migrations table
  (`orchestra.__drizzle_migrations`), verified in isolation against a
  scratch database not to collide with `pay-core`'s/`durable-ledger`'s/
  `agent-orchestrator`'s own migration journals.
- Durable-ledger's public Inngest callback does not make its business API
  public-by-default: `/workflows/*` and `/ledger/*` require a timing-safe
  `X-Service-Secret` check. Health and `/api/inngest` remain outside that
  service credential; Inngest authenticates its callback separately with
  `INNGEST_SIGNING_KEY`.

**Known limitation (by spec, not an oversight):** `apo_grant`/
`apo_customer_id` are `Secure` cookies, so the browser-facing grant flow and
the `X-Customer-Id` continuity it relies on only actually work over HTTPS
(Fly.io/Railway both terminate TLS). Testing them against a plain
`docker compose up` `http://localhost:3300` in a real browser will not
persist either cookie — this only affects the gateway's own HTML UI, never
the demo CLI (which talks to `agent-orchestrator` directly, not through the
gateway) or the JSON API surface when exercised with a tool that doesn't
enforce `Secure` (curl, `Hono`'s own test client).

The second `agent-orchestrator-live` compose service is behind the `live`
profile (`docker compose --profile live up`) and needs a real
`ANTHROPIC_API_KEY` — see `docker-compose.yml`'s own comments and ADR-0020
for why an unprofiled live service would crash-loop by default.

Exact local live-profile setup (values shown as shell-generated placeholders,
never commit the resulting secrets):

```bash
export DURABLE_LEDGER_SERVICE_SECRET="$(openssl rand -hex 32)"
export ADMIN_SECRET="$(openssl rand -hex 32)"
export GRANT_SIGNING_KEY="$(openssl rand -hex 32)"
export PUBLIC_BASE_URL="http://localhost:3300"
export ANTHROPIC_API_KEY="<real key>"
docker compose --profile live up -d --build
pnpm --filter @apo/orchestra demo --scenario all
```

Compose passes the three gateway variables through verbatim and shares the
durable secret with both orchestrator instances. Omit the gateway variables
for the default mock-only stack; grant minting then remains disabled.

## Deploy

The config-only deployment package now lives in [`deploy/`](deploy/): five
Fly.io app configs (gateway, mock/live orchestrators, durable-ledger, and
pay-core) plus a runbook covering external Postgres, managed Inngest,
secrets, private Flycast DNS, migration ownership, health checks,
scale-to-zero, rollback, and a Railway fallback. All app names are explicit
`replace-me-*` placeholders. Nothing has been provisioned or deployed from
this repository; no cloud credentials are assumed.
