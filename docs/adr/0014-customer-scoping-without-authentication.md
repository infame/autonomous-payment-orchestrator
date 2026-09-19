# 14. Customer scoping without authentication

Date: 2026-09-19

## Status

Accepted

## Context

Every mutating and read `app/*` use-case in `packages/agent-orchestrator`
was built, deliberately, with no caller-identity check of its own —
`get-intent.ts`, `answer-clarification.ts`, `reject-intent.ts`,
`approve-intent.ts`, and `sync-intent-execution.ts` each carry their own "No
caller/customer scoping (yet)" section, stating in increasingly forceful
language (culminating in `approve-intent.ts`'s: "This is not a hypothetical
gap to note in passing — it MUST be closed at the future HTTP/auth layer...
before this use-case is ever wired up as `POST /intents/:id/approve`") that
ownership scoping against `Intent.customerId` is deferred to the HTTP layer
this ADR now builds.

Nothing in this monorepo has a session or token model. `docs/todo/00-overview.md`
§5 (local-only, not in this repo) assigns the only session-like mechanism
that exists anywhere in the target architecture — a live-LLM budget grant —
to `orchestra`, a component that does not exist in this repo and, even where
it does exist, scopes a *spend budget*, not per-customer data ownership. No
package in this monorepo authenticates a caller today; `pay-core` and
`durable-ledger`'s own HTTP layers require only an `Idempotency-Key`, never
an identity.

## Decision

`X-Customer-Id` is the sole caller-identity channel
(`adapters/http/request.ts`'s `requireCustomerId`,
`adapters/http/server-schemas.ts`'s `CustomerIdHeader` — the identical schema
object `SubmitIntentCommand.shape.customerId` already validates with, not a
re-declared regex, so the two can never drift). `POST /intents` reads it and
passes it as `customerId` into `SubmitIntentCommand`, replacing the field
that used to live in the request body (`SubmitIntentBody` is
`SubmitIntentCommand.omit({ customerId: true })`). Every other, id-addressed
route (`POST /intents/:id/clarify`, `POST /intents/:id/approve`,
`POST /intents/:id/reject`, `GET /intents/:id`) reads the header, parses
`:id`, calls `GetIntent.execute(id)`, and compares the stored
`Intent.customerId` against the header value — on a mismatch, throws the
exact same `IntentNotFoundError` a genuine miss would throw, before calling
the route's real use-case.

### Why 404, not 403

A 403 on a mismatch would be an existence oracle: an attacker who can tell
"403 Forbidden" apart from "404 Not Found" learns that an intent with that id
exists and belongs to someone else, even without ever seeing its contents.
Returning the identical `IntentNotFoundError` shape either way closes that
channel. It's worse than a bare existence leak, too: `InvalidIntentStateError`
(422)'s message carries the intent's current status
(`Cannot approve an intent in state "rejected"`) — a 403-then-422 two-step
(403 on ownership, 422 on state) would leak the STATE of another customer's
intent as well as its existence. Collapsing both into an identical 404
closes both channels at once.

### Why enforced in the route handler, not the use-case command schemas

Each affected use-case (`AnswerClarification`, `RejectIntent`,
`ApproveIntent`, `SyncIntentExecution`) performs exactly one repository
write (or, for `ApproveIntent`, one external call plus one write) — see each
file's own "Exactly one repository write" section. Threading an ownership
check into the command schema or into the use-case body itself would mean
either a second `findById` inside the use-case (when it already re-reads the
intent for its own purposes) racing against the HTTP layer's own read, or
restructuring the use-case to accept a pre-fetched `StoredIntent` — a larger
change to five already-tested files for a concern that is purely about *who
is allowed to call this*, not *what this does*. The route handler already
has to read the intent once for `:id` validation to be meaningful; comparing
`customerId` there is the natural, minimal-diff place.

This is an explicit, binding constraint on any FUTURE driving adapter for
this package, not just documentation of what this one does: the `app/*`
use-cases themselves remain individually unsafe without a caller performing
this check. A CLI, a queue consumer, a second HTTP framework — any future
caller of `AnswerClarification`/`RejectIntent`/`ApproveIntent`/
`SyncIntentExecution`/`GetIntent` must repeat the same ownership comparison
before calling in, or it reintroduces the exact gap each use-case's own
header already warns about.

### What this explicitly does NOT do

This is not authentication. `X-Customer-Id` is a bare, unsigned,
trivially-spoofable header — anyone can claim to be any `customerId` by
setting it to an arbitrary value matching `CUSTOMER_ID_PATTERN`. There is no
token, no session, no proof of identity of any kind. This is acceptable
because `docs/todo/00-overview.md` §1's portfolio-project posture (also
local-only, not in this repo) scopes this system as a demonstration of
architecture, not a production multi-tenant service — real authentication is
explicitly out of scope for this repo, the same posture `pay-core` and
`durable-ledger`'s own HTTP layers already take with no auth of their own.

## Consequences

- **An extra repository read per id-addressed request.** Every
  `clarify`/`approve`/`reject`/`GET` call now performs one `GetIntent.execute`
  purely for the ownership check, in addition to whatever read the actual
  use-case performs internally (or, for `GET`, the ownership check's own read
  plus `SyncIntentExecution`'s separate read). This is an accepted cost, not
  optimized away by e.g. threading the already-fetched intent into the
  use-case — see "Why enforced in the route handler" above.
- **A non-constant-time comparison.** `existing.customerId !== customerId`
  is a plain string comparison, not constant-time. This is a timing oracle
  in principle — an attacker could in theory distinguish a near-miss from a
  far-miss by response latency. Explicitly accepted and out of scope for a
  portfolio system; closing it would need a constant-time compare with no
  practical benefit here.
- **An idempotency coupling with the auto-approve dead end.** `POST /intents`
  is only safe being non-idempotent (no `Idempotency-Key`, unlike
  durable-ledger's `POST /workflows/payment`) because nothing on the
  `SubmitIntent` path can trigger a real payment today — see the README's
  "Known limitation" on `Intent.autoApprove` having no production caller. If
  a future change wires auto-approve into `SubmitIntent` (giving `proposed →
  executing` a caller on the very first `POST /intents` call), that same
  change MUST add a client-supplied `Idempotency-Key` to `POST /intents` in
  the same change, or a retried submission becomes a second real payment —
  this ADR's customer-scoping mechanism says nothing about that risk and
  does not mitigate it.

## Considered and rejected

- **No scoping at all.** The status quo before this ADR — every `app/*`
  use-case reachable by anyone who knows an intent id. Rejected: explicitly
  called out as unacceptable by every affected use-case's own header once an
  HTTP layer exists to reach them.
- **403 on a mismatch.** Rejected — see "Why 404, not 403" above: it's an
  existence oracle, and combined with `InvalidIntentStateError`'s
  status-bearing message, a state oracle too.
- **`customerId` in the request body as a second channel.** Rejected: two
  channels for the same fact invites drift (which one wins on disagreement?)
  and doubles the surface a client has to get right. A single channel,
  consistently enforced, is simpler to reason about and to audit.
- **Identity threaded into the use-case command schemas.** Rejected — see
  "Why enforced in the route handler, not the use-case command schemas"
  above: a larger, riskier change to five already-tested files for a
  cross-cutting concern the HTTP boundary is better positioned to enforce
  once, uniformly.
- **A real token/session system.** Rejected for this repo's stated scope
  (`00-overview.md` §1) — see "What this explicitly does NOT do" above. Would
  be the correct next step for a production system, but is out of scope
  here.
