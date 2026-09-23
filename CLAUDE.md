# Team workflow

This repo uses a subagent team. Roles live in `.claude/agents/`. Full pipeline reference (setup, roles, hook mechanics) lives in `CONTRIBUTING.md` — `README.md` is the project's own front door (what this system is, how to run it), not the team-tooling doc.

- All work happens on a branch (`feat/<slug>` / `fix/<slug>` / `chore/<slug>`) off `main`. Commit freely there — no per-commit review gate.
- Non-trivial task → run `/feature <task>`. It creates the branch, then goes architect → implementer → test-runner → reviewer + security-reviewer → loop → report.
- Multi-step/multi-slice work (a whole package built across several `/feature` calls) gets ONE plan, ONE branch, and ONE implementer resumed across slices — not a fresh pipeline per slice. Final `test-runner` verification and both reviewers run once, on the complete package's frozen diff, not after every slice. An intermediate review round is allowed only when the plan names a separately-reviewable critical boundary (payments, security, auth, persistence, schema, migrations, external API contract); it doesn't replace the final gate.
- Hand-made changes → `/review` before merging, once the branch is ready.
- Landing on `main` is squash-only: `git checkout main && git merge --squash <branch> && git commit` (one line is fine to chain). The real gate is `.githooks/reference-transaction`, a git hook (wired via `git config core.hooksPath .githooks` — run once per clone, see CONTRIBUTING.md) that fires on *any* update to `refs/heads/main` regardless of how it happens (direct, wrapped in a script, `--no-verify`, `git branch -f`, `git update-ref`, cherry-pick, rebase, ...): `main` may only advance by exactly one commit whose content matches a branch `scripts/approve.sh <branch>` has recorded, which only happens after both reviewers return APPROVE on `git diff main...<branch>`. `scripts/guard-commit.sh` (a PreToolUse hook) is a separate, lighter check that blocks `--no-verify`/`--force`/`reset --hard` and anything that disables git hooks (`-c core.hooksPath=`, `--git-dir=`, `GIT_DIR=`) — no git hook can defend against the config that turns hooks off, so that one specific evasion is caught here instead. Together these are a guardrail against reflexively skipping the workflow, not a hardened boundary — nothing stops a Bash-capable agent from overwriting `.claude/.merge-approved` or the hook scripts directly; don't do that.

# Project conventions

- Stack: TypeScript (strict, ESM), pnpm workspaces monorepo, Node.js >=24. Per repo `@apo/pay-core` (`packages/pay-core`): Zod for validation, Vitest for tests. Planned but not yet wired: Hono (HTTP), PostgreSQL via Drizzle (only in-memory adapters exist today) — see `docs/todo/00-overview.md` §3 (local-only, not in this repo) for the full target stack.
- Module layout: hexagonal (ports & adapters). `src/domain` + `src/app` (use-cases) depend only on interfaces in `src/ports`; concrete implementations live in `src/adapters`. Domain never imports a vendor SDK. See `docs/adr/0002-ports-and-adapters.md`.
- Error handling: typed `DomainError` subclasses with a `code` discriminator (`packages/pay-core/src/domain/errors.ts`), not string/generic errors.
- Logging: not yet decided/implemented.
- Tests: `pnpm test` (root, runs `vitest run` across packages) or `pnpm --filter @apo/pay-core test`.
- Typecheck: `pnpm run typecheck` (root) or `pnpm --filter @apo/pay-core typecheck`.
- Lint: `pnpm run lint` (root, delegates to each package) or `pnpm --filter @apo/pay-core lint`. Flat config at `eslint.config.js` (type-checked via `typescript-eslint` + `projectService`). `scripts/post-edit.sh` runs `prettier --write` + `eslint --max-warnings=0` on each edited file after Edit/Write and now actually enforces it (eslint/prettier are root devDependencies).

# Product loop

- `/product` — product agent proposes hypothesis cards; owner scores them 1–5.
- `/spec H<n>` — approved hypothesis → GitHub issue with acceptance criteria, label `agent-ready`.
- `PRODUCT.md` is the single source of product truth for agents. Keep it current.
- Verdict precedence in review: security-reviewer > reviewer > test-runner.
