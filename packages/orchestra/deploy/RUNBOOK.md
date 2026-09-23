# Deployment runbook (configuration only)

These files describe a five-app Fly.io topology. They contain valid-looking,
deliberately non-live `replace-me-*` app names. This repository does not create
cloud resources, set credentials, run migrations, or deploy from this branch.

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
3. the home page says mock mode and a form submit reaches an intent detail
   page;
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
