# Portfolio deployment: one Fly VM

The primary portfolio topology is **one Fly app with one 1 GB shared-CPU
machine**, Neon Free PostgreSQL and Inngest Cloud Free. This package prepares
configuration and a tested image; it does not provision resources or deploy.
The older five-app configuration is retained below as a separate alternative.

## Runtime and public boundary

Build `deploy/Dockerfile.single-vm` from the repository root. The Node
supervisor starts pay-core → durable-ledger → mock agent-orchestrator →
orchestra, waiting for each `/healthz` before starting the next. Each existing
service applies its own migrations. The first three listeners bind only
`127.0.0.1` (3000, 3100, 3200); only orchestra binds `0.0.0.0:3300`.
The image runs as the non-root `node` user. Unexpected exit of any child,
including exit code zero, tears down all siblings and exits nonzero. There are
no child restart loops. SIGTERM/SIGINT is forwarded once, with a 15-second
supervisor deadline and 20-second Fly kill budget.

The gateway exposes the existing browser UI/API and **exactly**
`/api/inngest` (GET/POST/PUT) for Inngest. Callback requests carry original
bytes, query, Host and Inngest headers to the fixed internal endpoint. They do
not receive customer identity, session cookies or the ledger service secret.
The SDK verifies cloud signatures. Callback request bodies are limited to
1 MiB, responses to 4 MiB, and the complete transfer to 15 seconds; upstream
redirects are refused. Other `/api/inngest/*` paths return 404. Ledger and
pay-core business routes have no public listener. The normal browser API
remains public through the existing customer-session boundary.

Use a dedicated HTTPS origin such as `https://payments.example.com`, without
a trailing slash, path, query or fragment. Subfolder hosting is unsupported.
The supervisor requires `PUBLIC_BASE_URL` and gives it to the SDK as
`INNGEST_SERVE_ORIGIN`; the callback is registered at that same origin plus
`/api/inngest`. Preserve the public Host through any proxy, so hosted browser
cookies remain Secure. Configure the HTTPS certificate and DNS before
registering the callback. The Fly-provided HTTPS hostname is also usable.

The deployment is deliberately mock-only: child environments force
`LLM_MODE=mock`, deterministic `PAYMENT_PROVIDER=simulator`,
`DEMO_CHALLENGES_ENABLED=true` and `DEMO_RESEND_ENABLED=true`. No live agent is
started; Anthropic/admin/grant credentials and ambient endpoint overrides are
not forwarded. Payment/workflow/database/journal behavior is real; no real
money is moved. Only explicit local smoke mode enables the Inngest dev server.

## Prepare resources and deploy (operator action)

1. Provision a Neon database near the Fly region. Use a TLS connection string
   (`sslmode=require` or the provider's stronger supported verification mode),
   with a role permitted to create the four schemas and migration journals.
   Keep the database outside the VM lifecycle. Four services each own a pool;
   check provider connection limits and use Neon’s pooled endpoint if needed.
2. Create an Inngest Cloud environment and obtain its event key and signing
   key. Create one Fly app, replace both placeholders in `fly.demo.toml`, and
   configure the canonical HTTPS origin. Do not set `INNGEST_BASE_URL`:
   the cloud event and API origins are different. The supervisor forces
   `INNGEST_DEV=false` and `INNGEST_API_BASE_URL=https://api.inngest.com`.
3. Install only these secrets via Fly's secret store: `DATABASE_URL`,
   `DURABLE_LEDGER_SERVICE_SECRET` (independent random value, at least 32
   characters), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`. Use a secret
   manager or protected stdin (`fly secrets import -a <app>`); do not commit
   secrets or put their values in shared history/logs. No Anthropic key is
   needed. Never install `SINGLE_VM_LOCAL_TEST` or `LOCAL_INNGEST_URL` on Fly;
   local mode is explicitly rejected when `FLY_APP_NAME` is present.
4. After review/landing and explicit deployment authorization, run from the
   repository root:

   ```sh
   fly config validate --config packages/orchestra/deploy/fly.demo.toml
   fly deploy --config packages/orchestra/deploy/fly.demo.toml --ha=false
   fly machines list -a <app>
   ```

   `--ha=false` prevents creating an extra HA machine on a fresh deployment;
   it does not promise that an existing app has only one. Inspect existing
   machines first; reconcile to exactly one app machine using the Fly machine
   controls after identifying surplus machines and any attached volumes.
   Do not delete unrelated machines or apps. No Fly volume is required.

5. Register/sync `https://<origin>/api/inngest` in Inngest Cloud. Confirm the
   registered function callback URLs contain the public HTTPS origin, never
   localhost. Verify signed execution end to end in that environment; local
   smoke proves dev execution and cloud rejection of unsigned POSTs, not cloud
   registration, real signing credentials or production DNS/TLS.

`auto_stop_machines=stop`, `auto_start_machines=true`, and minimum zero suit
10–50 visitors/month. Both browsers and Inngest callbacks can wake the VM.
Cold starts include four processes, migrations and a potentially sleeping
Neon database; callbacks can retry. Fly caps service-check startup grace at
60 seconds, while each supervisor readiness wait is bounded at 120 seconds.
Monitor cold-start latency and failed checks before sharing the link. A 1 GB
allocation is a starting point, not a measured capacity guarantee; inspect
memory/CPU during a challenge. Check current provider limits/pricing before
provisioning; this topology does not promise a zero-cost Fly deployment.

## Local image verification

Requires Docker Compose, Node 24+, and the public PostgreSQL/Inngest images.
From the repository root:

```sh
docker build -f packages/orchestra/deploy/Dockerfile.single-vm -t apo-single-vm:local .
node packages/orchestra/deploy/smoke.mjs
```

The smoke harness creates a uniquely named disposable Compose project, uses
no published host ports, and removes its containers/data in `finally`. It
uses an isolated internal Docker network with no external egress. The local
service sets `SINGLE_VM_LOCAL_TEST=true` and uses Inngest v1.44.0; this is an
explicit test mode, never a fallback for missing cloud keys. A separate
cloud-mode container uses dummy keys and verifies an unsigned callback is
rejected without outbound registration. Tests cover all four schema migrations,
non-root runtime, loopback listeners, assets and browser identity, a completed
challenge with payment/journal/ledger proof, duplicate delivery, persistence
across restart, child-crash propagation and bounded graceful shutdown.

## Operations, recovery and post-deploy checks

- Before sharing: check gateway health/assets, cookie Secure attributes,
  challenge completion and operation evidence, cross-session isolation,
  invalid/unsigned callback rejection, Inngest's registered origin, and
  exactly one machine. Recheck after an idle stop/wake cycle. Never expose
  ports 3000/3100/3200, Postgres, or a dev Inngest console.
- Inspect Fly service logs and Inngest run history for failures. This is one
  fault domain: a failed service or deployment interrupts the whole demo.
  There is no high availability, and deployments may have downtime.
- Migrations run at boot. Snapshot/backup the database before changing schema;
  a failed migration stops startup. Do not blindly restart or run two versions
  against a half-applied migration. This package adds no migrations.
- Keep the previous reviewed image digest/release. Roll back to that image only
  if its schema compatibility is known. Image rollback does not undo database
  changes or completed workflows. Restore a database backup into a separate
  Neon database/branch, validate it, then deliberately switch the secret and
  restart the machine. Preserve workflow event identities and reconcile
  Inngest runs before accepting new demo actions; do not replay uncertain
  payments as a recovery shortcut.

---

## Alternative: five separate Fly applications (legacy configs)

These files describe a five-app Fly.io topology. They contain valid-looking,
deliberately non-live `replace-me-*` app names. This repository does not create
cloud resources, set credentials, run migrations, or deploy from this branch.

## Portfolio visitor endpoint

Use a dedicated HTTPS subdomain (for example `payments.example.com`) whose
root routes to the orchestra gateway on port 3300. Set `PUBLIC_BASE_URL` to
that HTTPS origin. The UI uses root-relative routes and cannot currently be
mounted in a folder such as `/payments/`. Hosted demos require HTTPS and
retain Secure cookies. Only the unsigned customer cookie omits Secure for
HTTP requests to exact loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) so
local mock sessions also work with Safari's strict cookie policy. Live-grant
cookies always stay Secure; use HTTPS for browser live mode.

Share only the gateway homepage with visitors. Its four failure challenges
exercise ten repeat deliveries, temporary provider failures, an unsupported
assistant amount, and a permanent authorization decline. Challenges use mock
reasoning and a simulated provider, with no real money moved. They are
unavailable in live mode. The source, proposal, policy reason, actual payment
snapshot, ledger entries, and delivery receipts stay in one same-page lab. Partial JSON polling is bounded to 60 checks
at 1.5-second intervals; visitors can manually check state after a pause or
error. Preserve the public Host through your reverse proxy so internal
loopback routing cannot select the local cookie exception.

Do not expose the local Inngest dev console (8288), PostgreSQL, orchestrators,
or pay-core. The managed Inngest callback exception below is an operator
integration, not a visitor page. The console shows best-effort recorded calls and exact capture ledger entries.
Inngest owns status; durable-ledger owns observations and ledger proof. Missing
records are explicit and never change payment behavior.

## Topology and prerequisites

- `orchestra` is the browser/API entry point and the only app intended for
  general public traffic.
- `agent-mock`, `agent-live`, and `pay-core` use private Flycast addresses.
- `durable-ledger` also serves the managed Inngest callback at
  `/api/inngest`. With the current HTTP `serve()` adapter, Inngest Cloud must
  reach that route over HTTPS, so this app needs a public address even though
  its business API is not intended for direct callers. The app itself enforces
  `X-Service-Secret` on every `/workflows/*` and `/ledger/*` route; health and
  the callback remain reachable, and callback signatures are verified with
  `INNGEST_SIGNING_KEY`. Moving the callback fully private requires an
  outbound-connect adapter and is outside this package.
- Provision one external PostgreSQL database reachable from all five apps.
  Require TLS in its connection string and keep it outside Fly machine
  lifecycle. The services isolate state by schema (`public`, `ledger`,
  `agent`, `orchestra`) but share the database.
- Create a managed Inngest app whose serve URL is
  `https://<durable-ledger-app>.fly.dev/api/inngest`.

Replace every `replace-me-*` value consistently. Keep all apps in the same
Fly organization and region. Run every command below from the repository root
so each Docker build has the pnpm workspace as its context.

## Secrets

Never place these values in TOML, shell history shared with others, or logs.
Set them through the platform secret store:

| App                             | Required secrets                               |
| ------------------------------- | ---------------------------------------------- |
| all five                        | `DATABASE_URL` (the external Postgres TLS URL) |
| durable-ledger, agent-mock/live | the same `DURABLE_LEDGER_SERVICE_SECRET`       |
| durable-ledger                  | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`     |
| agent-live                      | `ANTHROPIC_API_KEY`                            |
| orchestra                       | `ADMIN_SECRET`, `GRANT_SIGNING_KEY`            |

`ADMIN_SECRET` and `GRANT_SIGNING_KEY` must be distinct random values of at
least 32 characters. Generate a third independent 32+-character
`DURABLE_LEDGER_SERVICE_SECRET` and install the identical value on
durable-ledger plus both orchestrators. `PUBLIC_BASE_URL` is non-secret and
belongs in `fly.orchestra.toml`. Mock mode requires no Anthropic key.

In cloud mode, deliberately do not set `INNGEST_BASE_URL`: Inngest v4 uses
that one override for both registration/API and event ingestion, whose cloud
defaults are different origins. `fly.durable-ledger.toml` sets only
`INNGEST_API_BASE_URL=https://api.inngest.com` for the custom workflow-runs
REST adapter; the SDK keeps its own cloud event/API defaults.

After creating each app, allocate a private Flycast address for the four
downstream services so Fly Proxy can auto-start their zero-machine state:

```text
fly apps create <app-name>
fly ips allocate-v6 --private -a <app-name>
```

Allocate the normal public addresses only for `orchestra` and the managed
Inngest callback on `durable-ledger`. Confirm `fly ips list -a <app-name>`
before deploying; do not accidentally give the mock/live orchestrators or
pay-core public IPs.

## Migration ownership and first release

All four database-owning packages run their existing checked-in migrations at
boot. Exactly one process owns each schema migration:

| Schema      | Owner          | `MIGRATE_ON_BOOT`                |
| ----------- | -------------- | -------------------------------- |
| `public`    | pay-core       | `true`                           |
| `ledger`    | durable-ledger | `true`                           |
| `agent`     | agent-mock     | `true`                           |
| `agent`     | agent-live     | `false` (shares the mock schema) |
| `orchestra` | orchestra      | `true`                           |

Deploy in dependency order: pay-core, durable-ledger, agent-mock, agent-live,
then orchestra. Wait for each health check before continuing. The live
orchestrator must never be the first process to initialize the shared `agent`
schema.

Example (after replacing placeholders and setting secrets):

```text
fly deploy --config packages/orchestra/deploy/fly.pay-core.toml
fly deploy --config packages/orchestra/deploy/fly.durable-ledger.toml
fly deploy --config packages/orchestra/deploy/fly.agent-mock.toml
fly deploy --config packages/orchestra/deploy/fly.agent-live.toml
fly deploy --config packages/orchestra/deploy/fly.orchestra.toml
```

## Health and smoke checks

Every app exposes `GET /healthz`; Fly checks it on the configured internal
port. These are liveness checks, not dependency-readiness proofs. After a
release, verify:

1. each machine is healthy in `fly status -a <app-name>`;
2. `GET https://<orchestra-app>.fly.dev/healthz` returns `200`;
3. the homepage identifies the simulator and all four challenges run without
   leaving the page; repeat delivery returns ten actual receipts with the same
   payment identity and two unchanged ledger entry IDs;
4. Inngest shows the durable app registered, events arriving, and its signed
   callback healthy;
5. an operator-minted live grant routes one bounded call to agent-live, then
   `/session/mock` returns that browser to mock mode.

All configs set `min_machines_running = 0`, `auto_stop_machines = "stop"`,
and `auto_start_machines = true`. Expect a cold-start delay. Flycast (not raw
`.internal` DNS) is intentional for downstream URLs because private Fly Proxy
traffic can wake a stopped app. If cold starts cause upstream timeouts, first
raise the minimum machines for the affected service; do not remove gateway
timeouts or budget checks.

## Rollback

Record the image/release identifiers after every successful deploy (`fly
releases --image -a <app-name>`). For an application-only regression, deploy
the previous immutable image with `fly deploy --image <previous-image> -a
<app-name> --config <matching-config>`, then repeat its health and smoke checks.
Roll back dependents only when their contract also changed.

Database migrations in this repository are forward-only. Do not run ad-hoc
down migrations. If a migration fails or a release must be reversed after a
schema change, stop the affected writers, restore the external Postgres backup
or ship a reviewed forward repair, then redeploy in dependency order. Never
enable `MIGRATE_ON_BOOT` on agent-live as a rollback shortcut.

## Railway fallback

Railway can run the same five Dockerfiles with the repository root as build
context. Map each service's environment from the corresponding Fly TOML, use
Railway private DNS for internal URLs, expose only orchestra plus the
durable-ledger Inngest callback, and attach an external managed Postgres URL
instead of an ephemeral per-service database. Preserve the same migration
owner table, shared service secret, and deployment order. Railway's
sleep/wake behavior differs by plan, so verify cold-start behavior explicitly;
if private-service wake-on-
request is unavailable, keep one replica running rather than changing runtime
timeouts. No Railway project or config is created in this branch.

## Optional simulated resend

`DEMO_RESEND_ENABLED` defaults to false in both durable-ledger and agent.
For an explicitly simulated deployment, enable it at both services. Live
agent composition blocks resend regardless of the flag. Never enable it with
a real provider. Local compose enables it for its simulator.

The visitor submits only an intent ID. Agent checks customer ownership before
calling durable-ledger. Durable-ledger requires authoritative Inngest Completed
status plus the canonical capture group at the deterministic posting operation.
It resends the original capture body/key and the same stored posting drafts.
No new workflow is created. The UI reports actual responses and entry IDs.

The `ledger.execution_attempts` migration belongs to durable-ledger. Its
separate two-connection observation pool has bounded acquisition/query/SQL
timeouts; journal failures are best effort and do not alter retries or
compensation. Run existing migrations before new service code starts.

## Failure-lab opt-in and profile migration

The four fixed challenges additionally require `DEMO_CHALLENGES_ENABLED=true`
on the mock agent. Live composition refuses challenges and assigned profiles,
even if opted in. `DEMO_RESEND_ENABLED` remains independently required at agent
and durable-ledger for exact resend/batch behavior. Defaults are off; only
local simulator compose enables these controls automatically.

Agent owns the nullable immutable `agent.intents.execution_profile` migration,
atomic metadata write and credential resolver. Apply the new agent migration
before code serves challenges. Durable-ledger owns actual provider IO, safe
snapshot projection, recording and exact completed replay; no journal schema
change is needed for this extension. Unique intent-suffixed opaque simulator
credentials isolate fault counters between visitors and survive agent restart
through stored profile metadata. Simulator process resets still reset provider
counters and must not be presented as a stable external-provider guarantee.
