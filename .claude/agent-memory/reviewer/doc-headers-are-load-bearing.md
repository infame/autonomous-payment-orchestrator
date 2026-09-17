---
name: doc-headers-are-load-bearing
description: This repo's JSDoc headers are the contract of record and are written before/alongside code, so they drift — in review, check every header claim against the code and tests, not just the code.
metadata:
  type: project
---

Every file in `packages/*/src` carries a long JSDoc header that states the
design contract (nullability, "exactly one write", "never persisted",
rejection sets). Downstream slices are written from those headers, not from
the code, so a header that lies is a real defect, not a nit.

**Why:** on `feat/agent-orchestrator-submit-get-intent` (2026-09-16) the
`SubmitIntentResult.verdict` JSDoc claimed the field is `null` on an `allow`
outcome; the code returned the `AllowVerdict` and its own test asserted the
opposite. Everything compiled, linted and passed. The HTTP layer (next slice)
would have been written against the false claim.

**How to apply when reviewing:**
- For each "always/never/only/null when" sentence in a new or edited header,
  find the line of code and the test that make it true. If no test pins it,
  say so.
- Cross-check the header of the *port* against the header of the new
  implementation — this package states rules in the port file
  (`ports/llm-client.ts`, `ports/intent-repository.ts`) and violates them in
  `app/`.
- Specific recurring rule in `agent-orchestrator`: error messages may contain
  only ids/statuses/enums/thresholds — never `intent.text`,
  `proposal.reasoning/question/reason`, prompts, or vendor response bodies
  (stated in `ports/llm-client.ts` and honoured by
  `domain/agent-proposal.ts`). Copying pay-core's
  `JSON.stringify(_exhaustive)` exhaustiveness default
  (`pay-core/src/adapters/persistence/drizzle/mappers.ts`) into this package
  breaks it, because the stringified value is an LLM-authored object. The
  accepted remedy in this package (2026-09-16, `submit-intent.ts`) is
  `String((exhaustive as AgentProposal).kind)` — cast the `never` back to the
  union and serialize only the discriminator; it typechecks and lints clean.

See [[verify-db-claims-by-running]] for the same lesson on the persistence side.

**Second instance (2026-09-16, `feat/agent-orchestrator-answer-clarification`):**
headers here increasingly argue *why an alternative design would be wrong*
("relying on `propose()`'s guard would silently succeed for a `received`
intent"). That counterfactual is itself a contract claim and is the one most
likely to be untested — the use-case test covered a `proposed` intent, which
both designs reject, so it did not distinguish them. When a header says "X
would be wrong", find the test that exercises exactly X's distinguishing
input, not a neighbouring one.

Related convention worth checking on every new `app/*` use-case: the README
records that `GetIntent` "does not yet scope by caller/customer (deferred to
the future HTTP/auth layer)". A new *mutating* use-case that inherits that gap
must restate it — in this codebase silence in a header reads as "handled".

**Third instance (2026-09-16, `feat/agent-orchestrator-reject-intent`):**
headers were *accurate* this time — every "only/never/uniquely" sentence in
`domain/intent.ts`'s four-route discriminator and `app/reject-intent.ts`
checked out against code and tests. What recurs now is omission, not falsity:
- the return-shape asymmetry (`RejectIntent.execute` returns a bare
  `IntentView`, its mutating siblings return `{ intent, verdict }`) was
  deliberate but undocumented;
- the unscoped-caller gap (README line ~74, "does not yet scope by
  caller/customer") still is not restated on mutating use-cases, now twice
  (`AnswerClarification`, `RejectIntent`).
Ask for both on the next `app/*` slice (`ApproveIntent`), where "anyone with
an id can approve" is the sharper version of the same gap.

Test-double convention validated in that slice and worth expecting in
`ApproveIntent`: version conflicts are proved with a repository subclass
carrying a settable `race` hook that writes before delegating to
`super.update()` — NOT `answer-clarification.test.ts`'s
`Promise.allSettled` two-`execute()` race, which is non-deterministic when
the use-case has no `await` between `findById` and `update`. A conflict test
is only non-vacuous if it asserts the *winner's* final stored state, not just
that an error was thrown.

**Closed (2026-09-16, `chore/agent-orchestrator-scoping-deferral-notes`):** both
omissions above were fixed doc-only — a `## No caller/customer scoping (yet)`
section now exists on `get-intent.ts`, `answer-clarification.ts` and
`reject-intent.ts`, plus a `## Return shape` section on `reject-intent.ts`, and
the README's `RejectIntent` section closes with a "none of the four use-cases
scope by caller/customer" paragraph. Expect the same two sections on
`ApproveIntent`; if that slice's header is silent on scoping, it is a defect,
not a nit. Note the house style these sections established: name the future
route (`POST /intents/:id/approve`), name the field ownership would be checked
against (`Intent.customerId`), and name the step that must close it (step 8,
the Hono HTTP layer per README's 9-step list).


**Fourth instance (2026-09-17, `feat/durable-ledger-workflow-idempotency-key`):**
a new helper (`optionalIdempotencyKey`) was inserted into
`durable-ledger/src/adapters/http/request.ts` *between* the existing
`readJsonBody` JSDoc block and `readJsonBody` itself, leaving two stacked
JSDoc blocks above the new function and `readJsonBody` undocumented. Nothing
lies, but a contract header silently detached from its function. Check this
whenever a diff adds an `export function` near the top of an existing file:
the reference layout is pay-core's own `request.ts` (each helper carries its
own one-line header directly above it).

Header-validation testing note from the same branch: a Fetch `Headers` object
rejects NUL/CR/LF in a header *value* before the request reaches Hono, but
passes other control chars (`\x01`) through verbatim. So a "rejects control
characters" test for a header regex must use `\x01`, not `\x00` — with
`\x00` the test would throw in `Headers` construction and prove nothing about
the app's regex.

**Closed (2026-09-17, commit `437f9ad` on the same branch):** each function in
`durable-ledger/src/adapters/http/request.ts` owns its header again, in
pay-core's order (idempotency helper first, then `readJsonBody`).

Convention established by the same fix and worth expecting on every future
port/adapter slice in this repo: **a validation rule stated in a port's JSDoc
must be enforced by the adapter itself, not only at the HTTP boundary** —
`agent-orchestrator` is expected to call `durable-ledger`'s ports directly
(no `request.ts`), so "the route validates it" is not validation. The house
answer is to duplicate the regex into the adapter with a comment saying the
duplication is deliberate and naming the future direct caller, rather than
importing across the `http/` ↔ `inngest/` module boundary. Related trap seen
here: when an id is namespaced by concatenation (`prefix:${merchantId}:${key}`),
check whether the delimiter can occur in either component — if both are
free-form strings the namespace is ambiguous.
