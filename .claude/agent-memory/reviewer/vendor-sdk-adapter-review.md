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

**3. An earlier slice can DEFER a composition choice — check the later slice
actually made it.** `anthropic-llm-client.ts`'s header ends its "The API key
never reaches this class" section by saying the stronger runtime property
(nothing in the object graph carries the key) requires passing
`{ create: (p, o) => anthropicClient.messages.create(p, o) }`, not
`anthropicClient.messages` itself, and that "that composition choice belongs
to whatever constructs this class (the composition root, step 8)". Its own
test (`anthropic-llm-client.test.ts`, the `CANARY_API_KEY` /
`safeStringify` case) demonstrates the closure form. On
`feat/agent-orchestrator-composition-root` (2026-09-19) the composition root
passed `messages: anthropicClient.messages` — the type is satisfied, the
deferred decision was silently made the weak way, and the new header claimed
the strong property anyway ("only ever sees the narrow `{ messages: { create } }`
surface"). Probe that settles it in one command, from the package dir:
`node --input-type=module -e "import A from '@anthropic-ai/sdk'; const c=new A({apiKey:'SECRET'}); console.log(require('node:util').inspect({messages:c.messages}).includes('SECRET'))"`
— `util.inspect` at DEFAULT depth (what `console.log` uses) prints the key;
`JSON.stringify` merely throws on the circular ref, so "JSON.stringify is
safe" is not a defense.

**How to apply:** grep the previous slices' headers for "belongs to", "the
composition root", "not built yet", "step N" — any sentence that hands a
decision forward is a checklist item for the slice that receives it. "The
types line up" never discharges a deferred *runtime* property.

**Outcome (2026-09-19, re-review):** fixed the strong way — the live branch
now passes `{ create: (params, options_) => anthropicClient.messages.create(
params, options_) }`, and `composition-root.test.ts` pins it with a
`CANARY_API_KEY` + `inspect(client, { depth: null })` containment test.
Verified both halves independently: the SDK probe still leaks at default AND
unbounded depth, and re-creating `AnthropicLlmClient`'s
`constructor(private readonly options)` shape in a node one-liner shows
pre-fix `true` / post-fix `false` — see [[verify-regression-test-against-pre-fix]].
`util.inspect` does not walk closure scopes, which is the whole reason the
closure form holds; any future "just pass the resource, the type matches"
regression is caught by that one test.
