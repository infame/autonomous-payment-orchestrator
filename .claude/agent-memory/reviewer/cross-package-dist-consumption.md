---
name: cross-package-dist-consumption
description: How to review a slice where one workspace package imports a sibling's built dist (agent-evals -> agent-orchestrator) — the four toolchain facts already verified empirically, and the gap this pattern leaves (now closed here).
metadata:
  type: project
---

`@apo/agent-evals` is the first package here that imports a sibling
(`@apo/agent-orchestrator`) as a library instead of over HTTP (ADR-0016).
`pay-core` and `durable-ledger` still declare no `main`/`types`/`exports`,
so ADR-0005/0006/0011's "not importable" reasoning stays true — check that
before flagging a new ADR as contradicting them.

**Verified empirically 2026-09-20 (don't re-derive, just re-confirm if the
toolchain version moves):**
- pnpm 11 DOES run `pre<script>` hooks: `pnpm --filter @apo/agent-evals test`
  with `packages/agent-orchestrator/dist` deleted rebuilds it via `pretest`
  and passes. That is the only thing standing between this repo and a
  stale-dist false green.
- `pnpm -r <script>` silently SKIPS packages lacking that script (checked
  with `test:integration`: "Scope: 4 of 5", agent-evals absent, exit 0) — a
  new package needs no CI change to be covered, and needs no stub script.
- `pnpm -r run` is topologically sorted by workspace deps (agent-evals
  always runs last), so a root `pnpm run build` before typecheck is enough.
- `docker build` still works with an extra lockfile importer whose directory
  is NOT in the context: each Dockerfile copies only its own
  `package.json` and `pnpm install --frozen-lockfile --filter <pkg>...`
  tolerates the missing importer (built agent-orchestrator image, exit 0).
  So adding a package never needs a Dockerfile touch.

**The gap this pattern leaves — CLOSED for agent-evals (2026-09-20,
`feat/agent-evals-runner`, round 2):** `agent-evals` has `pretest`,
`pretypecheck` and `prelint`; `private: true` is on it and on
agent-orchestrator; ADR-0016's Consequences now names all three scripts and
the package README says the scripts rebuild for you. Re-verified by running
`pnpm --filter @apo/agent-evals typecheck|lint` (each rebuilds the
orchestrator first, both pass). `private: true` is safe only because no
Dockerfile/CI step uses `pnpm deploy`/`pnpm pack`/`npm publish` (grepped,
zero hits) — re-check if the packaging story changes.

**Still open for the NEXT consumer of this pattern:** CLAUDE.md advertises
bare root `pnpm run typecheck`/`lint`, which in a clone with no `dist/`
fails loudly (TS2307, then `no-unsafe-*` from typed linting), and
`scripts/post-edit.sh` runs `eslint <file>` directly with the same result.
Any new sibling-importing package must add its own `pre*` trio.
