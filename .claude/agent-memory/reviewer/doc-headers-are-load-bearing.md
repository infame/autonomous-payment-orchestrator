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

**Fifth instance (2026-09-17, `feat/agent-orchestrator-approve-intent`):** a new
failure pattern — **the test double hides the value the test needs to assert
the contract**. `FakeAgentCoreClient` records `calls[] = {request,
idempotencyKey}` but NOT the `eventId` it returned, and keeps its
key→real-run map private. So the branch's centerpiece test ("a crash leaves
the DUD eventId persisted, not the real one") could only assert
`persisted === retried.eventId` + `runCount === 1` — both of which a naive
"same key → same eventId" fake would also satisfy. The distinguishing
assertion (`calls[0].eventId !== calls[1].eventId`) was impossible to write.
**When reviewing any new in-process double: for each property its header
claims to model, check the double exposes enough state to assert that
property, and that the test actually asserts the distinguishing one.** Same
smell shows up in a test whose *title* claims more than its body checks
("durableLedgerEventId matches the fake's minted eventId" when the body only
asserts `not.toBeNull()`).

Two related recurring checks confirmed useful on the same branch:
- **Cross-package doc quantifiers drift from the ADR they cite.** ADR-0013
  says Inngest trigger dedup is a *bounded* guarantee ("holds only within
  Inngest's event-retention window"); the consuming package's README/header
  restated it as "at most one run ... ALWAYS". Compare quantifiers
  ("always/never/completely") against the cited ADR's own hedges.
- **Sibling-convention divergences need their own header section.** All other
  `app/*` use-cases read `this.clock()` as the first line of `execute()`;
  `ApproveIntent` reads it after the external call. The inline comment
  deferred to a header section that explained call-vs-write ordering, not the
  clock. A pointer to a section that doesn't cover the claim reads as
  documented but isn't.

**Re-review follow-up on the same branch (2026-09-17):** the fix for that last
bullet introduced a *new* header inaccuracy — the added "Why `this.clock()` is
read AFTER the external call" section justifies the divergence with "every
other use-case reads its clock up front because nothing in front of their one
write can take a variable, unbounded amount of time", but `SubmitIntent` and
`AnswerClarification` both read `this.clock()` first and THEN `await
this.llm.reason(...)`, which is exactly such a step (their real reason is that
one `now` has to be shared across several domain transitions). **A rationale
section written to satisfy a review comment is itself an unverified claim:
when it compares this file to siblings, open the siblings.** Cheap heuristic
that would have caught it: `grep -n "this.clock()" src/app/*.ts`.
