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
  `agent-orchestrator` instance, and serves a same-page experiment console plus manual HTML
  UI. (A managed Inngest deployment also needs the signed
  `durable-ledger` callback reachable by Inngest's control plane; see the
  deploy runbook.) See
  `docs/adr/0020-orchestra-gateway-and-the-second-orchestrator-instance.md`.

## Browser UI

`GET /` is the **Failure lab**: four fixed buttons start independent simulated
experiments: three use a $500 source invoice; the permanent-decline test uses
$600. Recorded source text remains authoritative after submission. The main scene follows source → APO → actual payment result.
Money starts unknown and comes from a safe pay-core snapshot, with Inngest
status and exact ledger evidence shown independently. The visible operation log
filters/selects real recorded operations. The duplicate test has two explicit
actions: make one normal payment, then press **Retry the same payment 10 times**.
Only the second action sends the ten deliberate duplicate commands and produces
ten receipts. They return one existing payment, not ten additional charges.

The same-page controller uses partial JSON polling and guards every response
by interaction generation. Requests and private API responses use `no-store`
so changing intent/evidence data is not treated as a cached result. Errors and
missing evidence remain explicit.
Mock home contains only the four fixed challenges. Standalone review pages and
the existing three CLI scenarios remain available; they do not assign isolated
simulator profiles. Live home is a separate ordinary request form that opens a
standalone review page, without mounting the mock controller.

UI form actions delegate through `/api/*` so grant selection, budgets,
timeouts and header filtering share one path. Challenge controls require mock
mode plus explicit server opt-in. No visitor can supply a provider token,
profile, payment ID, key or amount to the fixed challenge API.

## Demo scenarios

```
pnpm --filter @apo/orchestra demo --scenario all
```

| Scenario             | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — canonical**    | Ambiguous invoice → clarify → policy approval gate → approve → durable retry (a simulated `capture` failure, retried by Inngest) → completed, with ledger balance-delta evidence for both the merchant and `acquirer_clearing` accounts.                                                                                                                                                                                                  |
| **B — cancellation** | An intent is rejected at the approval gate before any money moves. **This is an honest orchestrator-level `reject`, not durable-ledger's saga compensation** — the saga path is proven correct in-process (`payment-execute-compensation.test.ts` in `@apo/durable-ledger`) but is not reachable through the live stack today (F2, `docs/todo/05-orchestra.md §3`). The narration says this explicitly; it is not dressed up as the saga. |
| **C — guardrail**    | An ungrounded amount proposal (one minor unit above the largest amount literally present in the intent text) is rejected outright, independent of magnitude, with zero core calls and no ledger effect.                                                                                                                                                                                                                                   |

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

**Browser session cookies:** local mock browsing supports browsers that reject
Secure cookies on HTTP loopback, including Safari. Only the unsigned
`apo_customer_id` cookie omits `Secure` when the request URL is plain HTTP
with the exact hostname `localhost`, `127.0.0.1` or `[::1]`. It retains
`HttpOnly`, `SameSite=Lax`, path and expiry protections. HTTPS and every other
hostname keep `Secure`; forwarded host/protocol headers cannot enable the
exception. Hosted demos require HTTPS.

Live credentials (`apo_grant` and `apo_grant_session`) always remain Secure.
Use HTTPS for live-grant browser flows; local HTTP live mode remains
unsupported in browsers such as Safari that reject those cookies. Strict
cookie-policy regression tests model the local create → redirect → detail
flow; actual Safari automation was not performed. The CLI does not depend
on browser cookies.

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

## Failure lab walkthrough

From the repository root, with Node.js 24+, pnpm and Docker:

```bash
pnpm install
export DURABLE_LEDGER_SERVICE_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```

Open <http://localhost:3300/>. Each attack button explicitly authorizes a fresh,
isolated **simulated payment** ($500 for the first three cases, $600 for refusal):

| Challenge | Actual mechanism | Inspect |
| --- | --- | --- |
| Make one payment | The first button completes one ordinary payment. After its snapshot and ledger pair are confirmed, a separate button sequentially retries the same capture and posting ten times. | Ten receipts, one payment identity, unchanged original entry IDs/counts. These are ten repeat deliveries plus the original workflow, not ten total API calls. |
| Try a temporary failure | Unique per-intent simulator token temporarily fails the first authorize **and** first capture calls. | Actual recorded errors followed by returned calls, authoritative payment snapshot and ledger entries. |
| Try an incorrect amount | Digit-free `sim.amount.inflated` makes the real mock propose $5,000 from the fixed $500 source. | The real `amount_not_grounded` policy verdict blocks it. |
| Try a refused payment | A real $600 proposal follows the existing policy approval mechanism, then uses an isolated permanent simulator decline. | An actual failed pay-core payment record with captured amount zero when the safe snapshot is available, not a claim that no payment record exists. |

Captured amount is unknown until pay-core returns a matching snapshot. Empty
best-effort call history never proves zero money moved. Workflow status comes
from Inngest; posting proof comes from the run's exact ledger operation.
Recorded calls can be missing or unfinished. A returned call does not imply
payment success and is not an invented HTTP status. Select/filter rows by
step, outcome or phase to see real timestamps, duration and key/entry correlation.
Short source, policy and accounting facts are inline below the log. Disclosures
are reserved for long operation, receipt and baseline JSON.

The UI automatically reads while execution is running or essential terminal
evidence is still missing: a completed payment needs its captured snapshot and
canonical ledger proof; a failed payment needs its actual payment snapshot.
Policy blocks before a workflow stop normally. Missing best-effort journal
records do not keep polling alive. Automatic reads stop after 60 attempts.

There is no routine check button, check counter, or no-change claim. After a
failed or paused read, **Reconnect** / **Retry loading evidence** performs only
GET requests and resets the bounded read budget. It never creates a payment or
resends the duplicate batch. Generation guards and existing selections survive.

Human policy text describes the actual actor: starting a preset authorizes its
simulation, including any approval handled by that test. The unmodified verdict
is retained with the complete intent/execution payload under Technical backend
state. Its unit label explicitly explains USD cents (`50000 = $500.00`); the
ordinary policy explanation does not present raw cents as dollar thresholds.

The ten-delivery batch is sequential, capped at ten and nine seconds overall,
with per-call deadlines and abort propagation. It stops on failed/unknown
outcomes and marks remaining deliveries not attempted. No new workflow is
created. Green duplicate verification requires all ten matching receipts and
actual payment/ledger proof matching the baseline saved before the second click.
The historical baseline stays visible if the latest read becomes unavailable;
unknown latest money is not replaced with the old value. A partial response remains uncertain even if a
late underlying idempotent operation eventually finishes.

Both `DEMO_CHALLENGES_ENABLED` and `DEMO_RESEND_ENABLED` default off. Local
compose opts into isolated mock challenges and simulator resend. Live agent
composition disables both features. The immutable execution profile is stored
atomically with intent metadata; credentials never enter the Intent aggregate
or browser. Ordinary manual requests retain their configured credential.

This lab does not simulate socket timeouts or concurrent load, and makes no
refund/saga or universal provider-guarantee claims. All provider IO uses the
simulator; no real money moves. Provider counter resets are not hidden.

For the original three CLI scenarios and additional balance-delta assertions:
`pnpm --filter @apo/orchestra demo`. The local Inngest console
<http://localhost:8288/> is for operators.

Host only the gateway root on a dedicated HTTPS subdomain. Root-relative
routes/assets do not support a folder mount. Preserve the public Host through
your reverse proxy; forwarded headers do not enable the loopback cookie
exception. Keep databases and downstream business APIs private. See the
[deployment runbook](deploy/RUNBOOK.md) for callback and configuration details.


### Retained request routes

Manual tools, examples, interactive review controls and the separate single
resend control were removed from mock home. The existing standalone review
and backend routes remain unchanged. Live home posts its ordinary unkeyed
form to `/ui/intents` and opens the standalone review flow; no mock challenges
or mock controller are mounted for live mode.

For compatibility, direct mock `/ui/intents` form submissions still accept a
nonsecret logical submission UUID. The gateway validates it, binds the existing
`Idempotency-Key` to exact text, and forwards it through `/api/intents`. That
existing API retains policy checks, approval requirements and customer scoping.
This is a retained route contract, not a manual tool offered on mock home.

Initial challenge submissions work without JavaScript and open a standalone
result. The explicit ten-retry test and same-page operation log require
JavaScript. A standalone low-value clarification page can show a saved permitted
proposal but cannot resume its original keyed submission; it never claims
execution has started.
