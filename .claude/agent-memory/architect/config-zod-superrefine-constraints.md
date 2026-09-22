---
name: config-zod-superrefine-constraints
description: Measured zod 3.25 behavior behind the three config.ts files (abort vs dirty decides whether superRefine runs; empty-string env vars coerce to 0), and the parity rules a new config.ts must keep with its package's own runtime validators.
metadata:
  type: project
---

Measured 2026-09-18 against the installed `zod@3.25.76` while planning
`agent-orchestrator`'s `config.ts` (the third copy of the
pay-core/durable-ledger `AppConfig` + `ConfigError` + `loadConfig` pattern).

**A MISSING required env var suppresses every `superRefine` issue; an
INVALID-but-present one does not.** Verified by running the schema:
ZodEffects' refinement branch returns `INVALID` when the inner object parse
aborted, but still executes the refinement when it is merely `dirty`
(`node_modules/.pnpm/zod@3.25.76/.../v3/types.js`, `effect.type ===
"refinement"`). A missing string → `invalid_type` → aborted. A present
string failing `.url()`/`.regex()`/`.positive()`/`.nonempty()` → dirty.
`z.coerce.number()` on a non-numeric string → NaN → `invalid_type` →
aborted too.
**Why it matters:** the whole selling point of these files is "one boot
error listing every issue". That property only holds *above* the
abort line.
**How to apply:** any test asserting "both cross-field issues surface
together" must supply every required var validly and break only
dirty-producing things. Don't promise "all issues, always" in a doc
comment.

**An env var that is SET BUT EMPTY (`FOO=` in compose/.env) coerces to `0`,
not to the schema default** — `.default()` only fires on `undefined`.
**Why it matters:** for any numeric limit where `0` is semantically
"disable everything" (e.g. `POLICY_DAILY_RATE_LIMIT` → `dailyRateLimit`,
which `policy/rules.ts` deliberately allows to be `0`), accepting `0` turns
a blank line in a compose file into a silent total outage, while
`.positive()` turns it into a loud boot failure.
**How to apply:** prefer `.positive()` on every numeric env var even when
the consuming runtime validator allows `0`, and say in a comment that the
config is deliberately stricter and why. Note `.int().positive()` is NOT
equivalent to `Number.isSafeInteger` — add `.safe()` when the consumer
checks that.

**Config-time validation must not be STRICTER than the package's own
runtime validator in ways that aren't justified by the env-var medium.**
Concretely: `resolvePolicyConfig` (`packages/agent-orchestrator/src/policy/
rules.ts`) rejects only `maxHardLimitAmount < maxAutoApproveAmount` —
equality is legal and coherent (below T auto-approves, at T gates, above T
rejects), so a config-level check must use `<`, not `<=`.
**How to apply:** before mirroring a cross-field rule into `config.ts`, read
the runtime validator's exact comparison operator. Mirror only rules whose
data lives in env vars; leave package-domain data (e.g. rules.ts's private
`ZERO_DECIMAL_CURRENCIES` set) to the runtime validator rather than forking
the list into bootstrap code — `SubmitIntent`/`AnswerClarification` call
`resolvePolicyConfig` in their constructors, so it still fails at boot.

**`z.enum`'s `invalid_enum_value` message echoes the received value** ("…
received 'yes'"). Harmless for `LLM_MODE`/`MIGRATE_ON_BOOT`; never use
`z.enum` for a secret-bearing var, or the "ConfigError never echoes a value"
test in all three packages becomes false.

Related: [[agent-orchestrator-http-step8-decisions]],
[[monorepo-package-wiring]].
