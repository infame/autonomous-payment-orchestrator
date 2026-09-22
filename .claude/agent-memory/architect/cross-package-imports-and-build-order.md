---
name: cross-package-imports-and-build-order
description: agent-evals is the first package to import a sibling (@apo/agent-orchestrator); why it resolves dist rather than a vitest src alias, and the build-before-typecheck contract that creates.
metadata:
  type: project
---

Decided 2026-09-20, planning agent-evals step 1 (`docs/todo/04-agent-evals.md` §12.1).

**`@apo/agent-evals` importing `@apo/agent-orchestrator` is the repo's first
real cross-package import.** Everything before it (ADR-0005, ADR-0006,
ADR-0011, `ports/agent-core-client.ts`) deliberately duplicated or faked the
other side instead, and ADR-0005 cites the missing `main`/`exports` as half
its rationale.
**Why:** evals is a *test harness*, not a service — the HTTP-only boundary
rule ADR-0005 protects applies to services talking to each other in
production, and the spec (§2) requires the runner to drive the SUT
in-process through its public export.
**How to apply:** don't read ADR-0005/0011 as "no package may ever import a
sibling" — read it as "no *service* may import another service's internals".
A new service-to-service import still needs its own justification.

**The consumer resolves the built `dist`, NOT a vitest/tsconfig alias to
`../agent-orchestrator/src`.**
**Why:** the point of step 1 is the `exports` map; an alias bypasses it, so a
missing re-export in `src/index.ts` or a broken `exports` entry would stay
invisible until something else consumed the package. An alias would also
have to be duplicated in *two* places (vitest `resolve.alias` + tsconfig
`paths`), and `tsc` with `rootDir: src` cannot emit for a path outside its
own rootDir without project references.
**How to apply:** the cost is a build-order contract — `tsc --noEmit` in a
dependent package fails with "cannot find module or its type declarations"
until `pnpm -r build` has run, and `dist/` is gitignored, so a fresh clone
and CI both must build first. `pnpm -r <script>` is topologically sorted by
default (verified: `--parallel` is documented as the flag that *disables*
sorting), so `pnpm run build` at the root is enough to order it.

**Stale `dist` is a silent-false-green hazard specifically for evals** (a
safety report generated against an old orchestrator build still says
"0 violations"), which is why agent-evals carries a `pretest` that rebuilds
the SUT even though CI already built it.

Related: [[monorepo-package-wiring]].
