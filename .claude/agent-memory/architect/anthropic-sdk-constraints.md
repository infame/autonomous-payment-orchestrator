---
name: anthropic-sdk-constraints
description: Verified-against-the-tarball facts about @anthropic-ai/sdk 0.126.0 that shape agent-orchestrator's AnthropicLlmClient — the silent ANTHROPIC_API_KEY env/config fallback, the error-class hierarchy and its instanceof ordering trap, and which Message/ToolUseBlock fields a hand-built test fixture must supply.
metadata:
  type: project
---

Verified 2026-09-17 by unpacking the published tarball (`npm pack
@anthropic-ai/sdk@0.126.0`) while planning spec step 7 of
`docs/todo/03-agent-orchestrator.md`. The npm registry IS reachable from this
sandbox (`npm view` works), so re-verify rather than trust this note.

**`new Anthropic({...})` silently falls back to ambient credentials when
`apiKey` is `undefined` — and ONLY when it is `undefined`.**
**Why:** `client.js`'s constructor does `if (apiKey === undefined) { apiKey =
readEnv('ANTHROPIC_API_KEY') ?? null }`, and with no key at all it further
resolves from config files / `ANTHROPIC_PROFILE` on the first request. So a
misconfigured `live` mode does not fail loudly — it picks up whatever
credential the host machine happens to have. `apiKey: ""` does NOT fall back
(it isn't `undefined`), it just earns a 401 on the first call.
**How to apply:** the composition-root factory must pass `apiKey` explicitly
and reject a blank/whitespace key BEFORE constructing the client. This is the
real reason step 7 needs its own guard even though `config.ts` (step 8) will
also validate — they defend different failure modes (missing env var vs.
ambient credential pickup).

**Error hierarchy (`core/error.d.ts`): `AnthropicError` ⊃ `APIError` ⊃
{`APIUserAbortError`, `APIConnectionError` ⊃ `APIConnectionTimeoutError`,
`BadRequestError` 400, `AuthenticationError` 401, `PermissionDeniedError`
403, `NotFoundError` 404, `ConflictError` 409, `UnprocessableEntityError`
422, `RateLimitError` 429, `InternalServerError` 5xx}. `RetryableError`
extends `AnthropicError` directly, NOT `APIError`.**
**Why:** `APIConnectionTimeoutError extends APIConnectionError extends
APIError`, so an `instanceof` chain written broadest-first collapses every
transport failure into one bucket and loses the timeout distinction.
`APIError.status` is `undefined` for the three transport classes and a number
otherwise; `APIError.type` carries the vendor's `error.type` discriminator
(e.g. `"rate_limit_error"`) and `requestID` is an opaque id safe to log.
**How to apply:** check `APIConnectionTimeoutError` → `APIConnectionError` →
`APIUserAbortError` → then branch on `APIError.status`. Build test fixtures
with `APIError.generate(status, body, message, new Headers())` — the SDK's own
factory — rather than `new RateLimitError(...)`, so the fixtures survive a
constructor-signature change. Never put `err.message` or `err.error` (the
vendor response body) into our own error message: on a 400 it can echo
request content, i.e. the customer's intent text.

**A hand-written `Anthropic.Messages.Message` test fixture needs all of
`id, container, content, model, role, stop_details, stop_reason,
stop_sequence, type, usage`, and a `ToolUseBlock` inside it needs
`caller` (newer required field) alongside `id/input/name/type`.**
**How to apply:** build them once in a shared fake/builder file, never inline
per test — a fixture missing one field is a typecheck failure, not a runtime
one, and the list grows with SDK minors. `client.messages.create` returns
`APIPromise<Message>`, which `extends Promise<WithRequestID<Message>>` and is
therefore assignable to a narrow `Promise<Message>`-returning port interface
(so the test double does not need to implement the whole `Anthropic` class).
`ToolChoiceAny` accepts `disable_parallel_tool_use`, which is what makes
"exactly one tool call" enforceable at the API level.

**The SDK is pre-1.0 (`0.126.0`), published as CommonJS with an `import`
condition (`index.mjs` + `index.d.mts`) and an `exports` map that includes
`./resources/*`, so NodeNext ESM resolution works.** A caret range on a 0.x
version pins to `>=0.126.0 <0.127.0` — minor bumps are breaking and will not
be auto-taken, which is the desired behaviour here; still matches this repo's
caret convention for every other dependency.
