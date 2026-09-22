---
name: dual-instruction-sets-codex-claude
description: The repo carries two parallel agent instruction sets (CLAUDE.md/.claude vs AGENTS.md/.agents/.codex); what to check when a diff touches either, incl. the shared hook scripts' Claude-only payload shape.
metadata:
  type: project
---

Since `chore/agent-instructions-efficiency` (2026-09-20) the same team workflow is
described twice:

- Claude side: `CLAUDE.md`, `.claude/skills/{feature,review,product,spec}/SKILL.md`,
  `.claude/agents/*.md`, hooks wired in `.claude/settings.json` (tracked).
- Codex side: `AGENTS.md`, `.agents/skills/*/SKILL.md`, `.codex/agents/*.toml`
  (`name`/`description`/`developer_instructions`, TOML `"""` block), plus
  `.codex/hooks.json` + `.codex/config.toml` — **tracked since 06f16c8
  (2026-09-21)**, previously untracked. `hooks.json` is a byte-for-byte twin of
  `.claude/settings.json`'s `hooks` block (PreToolUse:Bash -> guard-commit.sh,
  PostToolUse:Edit|Write -> post-edit.sh).

`AGENTS.md` opens with "`.claude` is not Codex instruction authority" — the two sets
are allowed to diverge by design, so they *will* drift.

**Why:** a gate described in two places can be tightened in one and silently
relaxed in the other; nothing tests prose.

**How to apply when reviewing an instructions-only diff:**
- Diff the new text against the counterpart file rather than reading it alone; call
  out relaxations (e.g. Codex `/feature` lets the coordinator author the plan for
  small bounded changes, Claude's says "do not skip stages"). Stricter divergence is
  fine, looser is a finding.
- Every factual claim about a script must be checked against the script. Docs here
  are wrong at least once: `CLAUDE.md` says `scripts/post-edit.sh` "actually
  enforces" lint, but it is `npx --no-install ... || true` + `exit 0` (see
  [[repo-lint-not-wired]]). `AGENTS.md`'s hedged version is the accurate one.
- **"Wired" != "runs".** `scripts/guard-commit.sh` and `scripts/post-edit.sh` read
  stdin and `jq -r '.tool_input.command'` / `.tool_input.file_path`, i.e. Claude
  Code's payload shape, and `[ -z ... ] && exit 0` on a miss. Under any other
  payload schema they silently no-op with zero output. Test it by piping a payload:
  `printf '{"command":["bash","-lc","..."]}' | ./scripts/guard-commit.sh` → exit 0,
  vs the `.tool_input` shape → exit 2. Flag any doc claiming the guard protects a
  non-Claude tool unless the payload shape is demonstrated.
- The real gate is tool-agnostic (`.githooks/reference-transaction`, see
  [[hook-gate-review-heuristic]]), so instruction drift can weaken habits but not the
  boundary — that usually keeps these findings at warning level, not blocking.
- Cheap mechanical checks: `python3 -c "import tomllib,glob;[tomllib.load(open(f,'rb')) for f in glob.glob('.codex/*.toml')+glob.glob('.codex/agents/*.toml')]"`,
  and `npx --no-install prettier --check <new md/json>` (repo-wide check fails on ~53
  pre-existing files, so only check the files the branch adds).
- Nothing in the repo or on this machine demonstrates the `.codex/*` schemas (no
  `codex` binary installed; the bundled `create-subagent` skill documents
  `.cursor/agents/*.md` instead). Treat schema-key correctness — `.codex/hooks.json`
  being read at all, project-scope `.codex/config.toml` being read at all — as an
  owner verification item, not a provable fact.
- `.codex/config.toml` sets `shell_environment_policy.inherit = "core"`, which drops
  everything outside HOME/PATH/USER/TMPDIR — notably `SSH_AUTH_SOCK`, and `origin`
  here is `git@github.com:...`. If Codex ever honours this file, check push/fetch.
  Its `[shell_environment_policy.set] CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` only
  reaches child shells; it is *not* the twin of `.claude/settings.json`'s `env`.

**Package review cadence (f2b943e Codex / 8ad551a Claude, 2026-09-22).** Both sides
now defer final test-runner + both reviewers to the *complete package's frozen
diff*, with an intermediate review only for a plan-named critical boundary. Known
asymmetries to re-check if either side is touched again:
- Codex `AGENTS.md` carries an evidence contract ("Evidence records `headSha`,
  `command`, `result`; reuse only when covered content and environment are
  unchanged"). Claude's `.claude/skills/feature/SKILL.md` says "reusing valid step
  evidence" with no such conditions, and `.claude/agents/test-runner.md` has no
  evidence concept at all.
- Codex says "After three *final* review rounds"; Claude's Stage 3 still says "Max 3
  review rounds **total**", so an intermediate boundary round may be read as eating
  the final budget.
- Claude's Stage 4 has no "package incomplete → stop, don't offer the merge command"
  exit; Codex step 5 ("otherwise report readiness") does. Backstop is the
  approve.sh/`reference-transaction` gate, so these stay warnings.
