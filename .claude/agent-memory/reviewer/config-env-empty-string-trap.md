---
name: config-env-empty-string-trap
description: Reviewing any packages/*/src/config.ts — zod .default()/.optional() only fire on undefined, so `FOO=` (blank env line) coerces to 0/"" and slips past; check every field, plus the two accepted fixes and the whitespace-only residual.
metadata:
  type: project
---

All three packages own a `src/config.ts` with the same shape (`AppConfig`
object + `superRefine` + `ConfigError` + `loadConfig`). Verified against
zod 3.25.76 in this repo (probe, 2026-09-18, re-probed 2026-09-19):

- `.default(x)` and `.optional()` fire on `undefined` ONLY. An env var
  present but empty (`FOO=`) is `""` and reaches the inner schema.
- `z.coerce.number().safeParse("")` → `0` (not NaN, no throw). So
  `z.coerce.number().int().min(0).default(10)` silently yields `0`.
- `z.enum` invalid-value message echoes the received value verbatim
  ("received 'sk-ant-...'"), which is why no secret-bearing field may be a
  `z.enum` — that rule is stated in `agent-orchestrator/src/config.ts`'s
  `ConfigError` header.
- `superRefine` still runs when a field is present-but-invalid (dirty), but
  is skipped when any field produces `invalid_type` — i.e. a MISSING var or a
  non-numeric value under `z.coerce.number()`. "All issues at once" claims in
  a `loadConfig` header must be hedged exactly that way.

**Two accepted fixes, chosen per field by whether `0` is legal:**
- `0` illegal → `.positive()` (loud boot failure). Used by
  `POLICY_DAILY_RATE_LIMIT`.
- `0` legal and meaningful → `z.preprocess((v) => (v === "" ? undefined : v),
  <inner>)` so a blank line falls back to "unset". Used by
  `ANTHROPIC_MAX_RETRIES` (0 = "no SDK retries"). Probe-confirmed: `"0"`→0,
  `"3"`→3, `"abc"`→invalid_type, `"-1"`→min(0) error, unset → key absent.

**Residual, known and non-blocking:** the `v === ""` preprocess does NOT
catch whitespace-only (`FOO="   "` still coerces to `0`). `.positive()`
fields are loud there; preprocess fields are not. If a future field copies
this pattern, prefer `typeof v === "string" && v.trim() === ""`.

**How to apply when reviewing a config.ts:** walk every field and ask what
`FOO=""` does. A field whose validator rejects `0`/`""` (`.positive()`,
`.min(1)`, `.url()`, `z.enum`) is safe and loud; `.min(0)` / plain
`z.string()` / `.optional()` numerics are the holes.

See [[doc-headers-are-load-bearing]], [[verify-regression-test-against-pre-fix]].
