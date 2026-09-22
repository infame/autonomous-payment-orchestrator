---
name: compose-secret-env-passthrough
description: In docker-compose.yml, a map-form env key with NO value passes the host var through and leaves it genuinely UNSET when absent; `${VAR:-}` instead sets it to "" and breaks every z.string().min(1).optional() config field.
metadata:
  type: project
---

Verified empirically 2026-09-19 (Docker Compose v2.30.3-desktop.1) while
planning `agent-orchestrator`'s compose service, with a throwaway compose file
plus `docker compose config` and `docker compose run --rm ... sh -c '[ -z
"${VAR+x}" ]'`.

**For any secret-shaped env var in `docker-compose.yml`, use the map-form
key with an empty value (`ANTHROPIC_API_KEY:`), never `${ANTHROPIC_API_KEY:-}`.**

- `ANTHROPIC_API_KEY:` (null value) → `docker compose config` renders
  `ANTHROPIC_API_KEY: null`, and inside the container the variable is
  **absent** (`[ -z "${VAR+x}" ]` is true). Set it on the host and the value
  is passed straight through.
- `${ANTHROPIC_API_KEY:-}` → the variable is **present and empty**.

**Why it matters here:** every optional secret in this repo's `config.ts`
files is `z.string().min(1).optional()`. `.optional()` only fires on
`undefined`, so a present-but-empty var fails `.min(1)` and the service
refuses to boot — the same `FOO=""` trap documented per-field in
`packages/agent-orchestrator/src/config.ts`
(see [[config-zod-superrefine-constraints]]). A `${VAR:-}` default in compose
would turn "no API key, run in mock mode" into a hard boot failure.

**How to apply:** secrets (`ANTHROPIC_API_KEY`) → bare map key, no value.
Non-secret demo placeholders that are *required* by config
(`PAYMENT_METHOD_TOKEN`) → `${PAYMENT_METHOD_TOKEN:-pm_demo_token}`, so the
stack comes up with zero host env but is still overridable. Never a real
credential literal in the file.

Related: [[pay-core-docker-runtime]] for the image-build side of the same
stack (busybox `wget` for healthchecks, `CI=true`, the paired `node_modules`
copy).
