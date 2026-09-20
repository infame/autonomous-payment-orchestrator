# 16. agent-evals imports the built orchestrator

Date: 2026-09-20

## Status

Accepted

## Context

[ADR-0005](0005-duplicate-money-across-packages.md) and [ADR-0011](0011-no-third-money-copy.md) justified duplicating code across packages partly because packages were not importable by their siblings (no `main`/`types`/`exports`). `@apo/agent-evals` is the first real cross-package import in this monorepo.

The rule that packages talk to each other only over HTTP is a rule about services. `agent-evals` is a test harness that drives the system under test (`@apo/agent-orchestrator`) in-process (spec 04 §2/§11), not a peer service.

## Decision

`@apo/agent-orchestrator` gains `main`, `types` and an `exports` map (`.` and `./package.json`) pointing at its built `dist`. `@apo/agent-evals` depends on it via `workspace:*` and consumes only that public `exports` map: never `src`, never a deep import.

Rejected alternative: a vitest alias to the orchestrator's `src`. It bypasses the `exports` map (so the map would never be exercised), requires duplicating tsconfig `paths`, and causes `rootDir` problems.

## Consequences

- Build-before-typecheck contract: `dist/` is gitignored and agent-evals typechecks against the emitted `.d.ts`, so CI runs `pnpm run build` before typecheck/lint/test (`pnpm -r` is topologically sorted).
- `agent-evals` has `pretest`, `pretypecheck` and `prelint` scripts that build the orchestrator, guarding against a stale `dist` producing a silent false green.
- The orchestrator's public surface (its `index.ts` exports) is now a contract that agent-evals depends on.
