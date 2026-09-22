---
name: pay-core-docker-runtime
description: Verified toolchain constraints for containerising @apo/pay-core — pnpm-in-Docker gotchas (no-TTY purge abort, deploy --legacy), the workspace node_modules copy pattern, and why the drizzle/ folder must ship next to dist/.
metadata:
  type: project
---

Findings from empirically building a probe image against this repo's real
pnpm workspace (2026-09-10, branch `feat/runnable-service`, Docker Desktop
4.36 / BuildKit, pnpm 11.1.3, node:24-alpine). Each of these was *verified by
running it*, not reasoned about.

**1. `pnpm install --prod` inside Docker aborts without a TTY.** Re-running
`pnpm install --frozen-lockfile --filter @apo/pay-core... --prod` over an
existing `node_modules` (the dev-deps-prune step of a multi-stage build) dies
with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, because pnpm wants to
confirm purging the modules dir.
**Why:** pnpm ≥10 refuses destructive `node_modules` removal non-interactively.
**How to apply:** set `ENV CI=true` in the build stage (or
`--config.confirmModulesPurge=false`). Without it the build fails at the very
last build-stage layer, after the slow install+tsc layers — expensive to
discover late.

**2. `pnpm deploy` needs `--legacy` here.** Plain
`pnpm --filter @apo/pay-core deploy --prod <dir>` fails with
`ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`; pnpm ≥10 only deploys from workspaces
with `inject-workspace-packages=true`. `deploy --legacy --prod` *does* work and
emits a correct self-contained tree, but re-resolves the full dependency graph.
**How to apply:** prefer the explicit multi-stage prune (install → tsc →
`--prod` reinstall → copy) over `deploy`; it honours `--frozen-lockfile` and
avoids depending on a deprecated flag. Only revisit `deploy` if a future
package here gains a real `workspace:*` dependency (pay-core currently has
none — all four runtime deps are external).

**3. Copying pnpm's symlinked layout across stages works, but only as a pair.**
`COPY --from=build /repo/node_modules` **and**
`/repo/packages/pay-core/node_modules` to *identical* paths in the runtime
stage. The per-package dir is relative symlinks into the root `.pnpm` virtual
store; both trees must land at the same absolute paths or every `import`
breaks. Verified: `require.resolve('hono'|'pg'|'drizzle-orm')` all resolve and
`vitest` is correctly absent after the prod prune.

**4. `drizzle/` must ship in the image next to `dist/`.**
`migrator.ts` resolves the migrations folder as `../../../../drizzle` from
`import.meta.url`, which lands on the *package root* from both `src/` and
`dist/` — so a runtime image with only `dist/` finds no migrations and silently
has nothing to apply.

**5. `node:24-alpine` has busybox `wget` (no curl) and a `node` uid-1000 user.**
So a compose healthcheck can be `wget -qO- http://127.0.0.1:$PORT/healthz`
without installing anything.

**6. Build context must be the repo root, not the package dir** (the lockfile
and `pnpm-workspace.yaml` live there), so a `Dockerfile` placed at
`packages/pay-core/Dockerfile` has repo-root-relative `COPY` paths and needs a
root `.dockerignore`. The repo had no `.dockerignore`; without one the context
includes the whole root `node_modules` + `.git`.

Probe image size with the prune approach: ~285 MB.

See [[pay-core-persistence-decisions]] for why the pool exists at all and why
`close()` matters on shutdown.
