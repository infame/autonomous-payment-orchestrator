---
name: infra-docker-compose-review
description: How to actually verify a Dockerfile/docker-compose/CI slice in this repo — the three sibling Dockerfiles are byte-identical modulo package name, and compose env quirks (bare key vs ${VAR:-}) are verifiable in about 60 seconds.
metadata:
  type: project
---

Each of the three packages ships the *same* Dockerfile modulo the package
name and `EXPOSE` port. Reviewing a new one is therefore a `diff`, not a
read: `diff packages/durable-ledger/Dockerfile packages/<new>/Dockerfile`
should show only the name/port substitutions. Anything else is either a bug
or needs a stated reason.

Load-bearing details that the diff must preserve (each has a comment in the
file saying why): `ENV CI=true` in the build stage (without it the `--prod`
prune dies with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`), copying BOTH
`/repo/node_modules` and `/repo/packages/<pkg>/node_modules` from the build
stage, and copying `drizzle/` from the build **context** (it is never copied
into the build stage). Because `tsconfig.json`'s `include` is
`["src/**/*.ts"]`, `docker build` typechecks the `*.test.ts` files too — so
the Docker build is a stricter typecheck than a dev machine with stray
global `@types/*` directories above the repo (there is one under
`/Users/infame/web/node_modules/@types` carrying React types).

**Verification recipe that paid off (all cheap, all decisive):**
- `docker run --rm --entrypoint sh <img> -c 'id -un; ls dist/main.js drizzle'`
  plus a one-line `path.resolve(...)` of `migrator.ts`'s
  `"../../../../drizzle"` from its `dist/` location — that is the check that
  catches "shipped zero migrations".
- `docker compose -p <scratch> up -d --build` then `docker compose -p <scratch> ps`
  + `curl :<port>/healthz`. The whole 5-service stack converges in ~20s and a
  real `POST /intents` round-trips. Always use `-p <scratch>` and
  `down -v` afterwards so you don't clobber the user's stack.
- Counterfactuals are one `docker run -e VAR=... <img>` away — e.g. proving
  `ANTHROPIC_API_KEY=` (empty) crashes in `loadConfig`.

**Compose env-map quirk, verified empirically:** a bare `FOO:` key leaves the
variable genuinely ABSENT in the container when unset on the host; `FOO: ${FOO:-}`
makes it PRESENT-but-EMPTY. That distinction is load-bearing here because
`config.ts` uses `z.string().min(1).optional()` for secrets, and `.optional()`
only fires on `undefined` — see [[config-env-empty-string-trap]] for the same
trap in the other direction. Two-container probe:
`services: {a: {image: alpine, command: [sh,-c,'printenv BARE || echo no'], environment: {BARE:, DEF: "${DEF:-}"}}}`.
So a bare key in an `environment:` map is *correct*, not a typo, whenever the
schema treats absent and empty differently — do not flag it, and do not let
anyone "simplify" it.

**CI scope:** `.github/workflows/ci.yml`'s `check`/`integration` jobs run root
`pnpm -r typecheck|lint|test|test:integration`, so a new package is covered
automatically the moment it has those scripts; only the `docker` job needs a
per-package line. The `integration` job's inline comments still say "both
packages" and are stale for a third package — pre-existing, not a new branch's
fault.
