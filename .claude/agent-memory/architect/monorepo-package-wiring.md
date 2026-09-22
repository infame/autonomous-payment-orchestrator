---
name: monorepo-package-wiring
description: Adding a workspace package needs zero root config changes (verified); the per-package vitest.config.ts always fails typed lint and that is pre-existing, not a regression.
metadata:
  type: project
---

Verified 2026-09-10 while scaffolding the second package.

**A new `packages/<name>` needs no change to `pnpm-workspace.yaml`,
`eslint.config.js`, `tsconfig.base.json`, or the root `package.json`.**
**Why:** the workspace glob is `packages/*`; root scripts are all `pnpm -r`;
the flat ESLint config matches `**/*.ts` with `projectService: true`, which
resolves each file's nearest `tsconfig.json` on its own.
**How to apply:** a new package only needs its own `package.json` declaring
`build`/`typecheck`/`test`/`lint` (a package missing one of those scripts is
*silently skipped* by `pnpm -r`, not reported), plus a `tsconfig.json`
extending `../../tsconfig.base.json`. Then `pnpm install` once at the root.

**`npx eslint packages/<pkg>/vitest.config.ts` always errors with "was not
found by the project service".**
**Why:** package `tsconfig.json`s `include` only `src/**/*.ts`, so root-level
config files belong to no project. `pay-core` has had this since its vitest
config landed and the repo is green because `lint` is `eslint src` and
`scripts/post-edit.sh` is non-blocking (`exit 0`).
**How to apply:** when the post-edit hook shouts about a newly created
`vitest.config.ts`/`drizzle.config.ts`, ignore it. Do **not** "fix" it by
widening the root ESLint config or the package's tsconfig `include` —
widening `include` would also drag config files into `dist/`.

**ESLint's `restrict-template-expressions` allowlist matches by class *name*
only** (`allow: [{ from: "file", name: "Money" }]`, with an in-file comment
explaining the cwd reason). A second, unrelated class named `Money` in another
package is therefore allowed in template literals for free.
