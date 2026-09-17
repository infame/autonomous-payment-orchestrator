---
name: vendor-sdk-adapter-review
description: Reviewing a vendor-SDK adapter here — verify every SDK behavior claim by reading node_modules and running a throwaway probe test, and remember that `cause` chains leak content even when the message is clean.
metadata:
  type: project
---

`agent-orchestrator`'s `adapters/llm/*` (step 7, `AnthropicLlmClient`) is the
first adapter in this repo wrapping a real vendor SDK. Two review techniques
paid off there and generalize to the HTTP/Hono and any future vendor slices.

**1. Verify SDK behavior claims against `node_modules`, then probe.** Headers
and commit messages here assert non-obvious vendor behavior as fact. All three
assertions on that branch were *true*, and each took one grep / one throwaway
test to confirm:
- `@anthropic-ai/sdk` `core/error.mjs`: `APIError.generate(status, body, msg,
  headers)` returns a bare `APIConnectionError` when `headers` is falsy, so a
  test fixture must pass a real `new Headers(...)` or every status case
  silently collapses into one branch.
- `core/resource.mjs`: `APIResource` stores `this._client = client`, and
  `BaseAnthropic.apiKey` is a public own property — so passing
  `client.messages` into an adapter really does put the API key in the
  adapter's serializable object graph.
- `client.mjs` ~line 76: `apiKey === undefined` falls back to
  `ANTHROPIC_API_KEY` then a config-file/profile chain; `""` does not fall
  back, it just 401s later.

Probe recipe: copy a `zz-probe.test.ts` into the package's own `src/` (vitest
`include` won't pick it up from the scratchpad), run
`pnpm exec vitest run src/.../zz-probe.test.ts` from the package dir, delete
it after. Write the probe as the assertion you *expect to fail* — that is what
proves a claim, not a passing test.

**2. A clean error message is not a clean error.** This package's port rule
(`ports/llm-client.ts`) is "error messages may contain only ids/statuses/
enums" — see [[doc-headers-are-load-bearing]]. The step-7 branch honoured it
in `mapAnthropicError` (and even argued, correctly, that `cause` must NOT be
attached on the `APIError` branch because `APIError#error` is the response
body) — and then attached `InvalidProposalError` as the `cause` of
`LlmProtocolError` in `anthropic-llm-client.ts`, with an inline comment
claiming it was safe. It isn't: `paymentProposal()` interpolates
`JSON.stringify(input.currency)` / `input.merchantId` into its message, and
those are *unbounded, model-authored* strings precisely when they're invalid.

**How to apply:** on any adapter that maps foreign errors to this repo's typed
errors, check the `cause` chain, not just the top message — walk to every
`.cause` and ask what model/vendor/customer-authored strings its message
interpolates. Also check any raw interpolation of vendor-response fields
(`block.name`, tool names, ids) — "it's just a discriminator" only holds if
something bounds it. A branch that gets the `cause` rule right in one file and
wrong in another is the normal shape of this bug.

**Outcome (2026-09-17):** the branch fixed it by dropping `cause` on that
rewrap entirely (no `cause` argument) and adding a `merchantId`-canary scenario
to the table-driven leak sweep, plus a `describeToolName()` charset gate on the
raw `block.name` interpolation. Verified by running the new test against the
pre-fix commit — see [[verify-regression-test-against-pre-fix]].
