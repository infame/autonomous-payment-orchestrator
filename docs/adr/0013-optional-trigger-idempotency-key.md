# 13. An optional caller-supplied Idempotency-Key on the payment trigger

Date: 2026-09-17

## Status

Accepted

## Context

Discovered while planning `ApproveIntent` in `packages/agent-orchestrator`,
which needs a genuine exactly-once guarantee against `POST
/workflows/payment`: an approved intent must trigger *at most one*
`payment.execute` run, even if the caller retries the HTTP request (a
network timeout on the client side, an at-least-once queue redelivery, an
operator re-clicking "approve").

Before this step, `InngestWorkflowRuns.startPaymentExecute`
(`src/adapters/inngest/inngest-workflow-runs.ts`) called
`inngest.send({ name, data })` with no `id`. Two HTTP requests carrying
identical `data` therefore produced two fully independent Inngest event ids
and two fully independent `payment.execute` runs — two authorizations, two
captures, two ledger postings. Nothing in this package's *existing*
idempotency machinery closes that gap: `stepIdempotencyKey`/`stepOperationId`
(`src/workflow/idempotency-key.ts`, `src/workflow/operation-id.ts`) are both
deterministic functions of a run's own `runId`, derived and consumed
*inside* `payment.execute` (`src/workflow/payment-execute.ts`) to make a
single run's steps safe to retry. By construction they cannot see across two
separate runs — each run gets its own `runId`, so each run computes its own,
different, internally-consistent set of keys. Closing the two-runs gap
required something upstream of `runId` even existing, at the trigger itself.

Two empirical facts, verified against a live `inngest/inngest:v1.44.0` dev
server before deciding (not assumed from the SDK's types):

- **`inngest.send()`'s `id` field deduplicates at the event layer.** Two
  sends carrying the same `id` produce two different, server-assigned event
  ULIDs, but exactly **one** run — attached to only one of the two events.
  The other ("loser") event's `GET /v1/events/<id>/runs` answers
  `{"data":[]}` **permanently** — not "eventually consistent", a durable,
  forever-empty answer. Reproduced directly against a running stack
  (`inngest/inngest:v1.44.0`, this repo's `docker-compose.yml`):

  ```
  $ K=$(uuidgen)   # 86A3CA95-63D1-40DA-9E0C-FE6FDC081279
  $ for i in 1 2; do
      curl -s -X POST localhost:3100/workflows/payment -H 'Content-Type: application/json' \
        -H "Idempotency-Key: $K" \
        -d '{"amount":2000,"currency":"USD","paymentMethodToken":"sim.ok","merchantId":"m1"}'; echo
    done
  {"eventId":"01M2Q9HDKRYM85PM45Z32ZZQTQ","statusUrl":"/workflows/01M2Q9HDKRYM85PM45Z32ZZQTQ"}
  {"eventId":"01M2Q9HDM7MGAVN423VJDBSXDB","statusUrl":"/workflows/01M2Q9HDM7MGAVN423VJDBSXDB"}

  $ curl -s localhost:8288/v1/events/01M2Q9HDKRYM85PM45Z32ZZQTQ/runs
  {"data":[],"metadata":{...}}
  $ curl -s localhost:8288/v1/events/01M2Q9HDM7MGAVN423VJDBSXDB/runs
  {"data":[{"run_id":"01M2Q9HDPTDDB3R16KSB6R1V6H","status":"Completed", ...,
            "event_id":"01M2Q9HDM7MGAVN423VJDBSXDB", ...}], "metadata":{...}}
  ```

  Two `202`s, two distinct `eventId`s, exactly one run — in this run the
  second-sent event happened to carry it and the first-sent event was the
  permanent dud; which of the two ends up the "winner" is an internal
  Inngest ingestion detail this ADR does not depend on and does not
  guarantee either way. The architect's own earlier concurrent-duplicate
  testing (3 trials, concurrent rather than sequential sends) additionally
  confirmed this is atomic under a race, not just under sequential requests.
- **`id: ""` silently disables dedup.** An empty string is treated by
  Inngest as "no id supplied", not as an empty (and therefore always-equal)
  key — passing it through unconditionally would look like dedup while doing
  nothing. A blank key must be rejected outright, never forwarded as `""`.

## Decision

`POST /workflows/payment` accepts an optional `Idempotency-Key` HTTP header.
When present, `optionalIdempotencyKey` (`src/adapters/http/request.ts`)
validates it against `IdempotencyKeyHeader`
(`src/adapters/http/server-schemas.ts`) and passes it to
`WorkflowRuns.startPaymentExecute` as
`StartPaymentExecuteOptions.idempotencyKey`
(`src/ports/workflow-runs.ts`). `InngestWorkflowRuns` forwards it to
`inngest.send()` as the event's own `id` field, namespaced under a
`payment-execute:<merchantId>:` prefix (`DEDUPE_ID_PREFIX`,
`src/adapters/inngest/inngest-workflow-runs.ts`) so it stays visibly
distinct from any other id space in Inngest's dashboard, and so two
unrelated callers who happen to pick the same "natural" key for two
*different* merchants (`order-1`, a shared counter, ...) don't collide with
each other — see Consequences for the residual collision risk this
namespacing does not close. A blank key (empty, or whitespace-only) is
rejected, and so is a key that fails the same shape contract
`IdempotencyKeyHeader` enforces at the HTTP layer (printable ASCII, no
spaces/control characters, 200-char max) — duplicated onto the adapter
itself (`IDEMPOTENCY_KEY_SHAPE`,
`src/adapters/inngest/inngest-workflow-runs.ts`) rather than trusted to
whichever caller happens to be upstream, since a future direct caller of
this port (`agent-orchestrator`'s planned `ApproveIntent`, which will not go
through `request.ts`/HTTP at all) must get the same validation an HTTP
caller gets for free. Both failure modes are `400 validation_failed` at the
HTTP layer, and a plain `Error` (thrown before the port's existing
try/catch, so it is never mistaken for `WorkflowEngineUnavailableError`) if
some other caller reaches the port directly.

A header, not a request-body field, for three reasons: (1)
`StartPaymentWorkflowBody` (`server-schemas.ts`) is a direct re-export of
`paymentExecuteRequestedSchema` — the Inngest event's own data schema — and
must never drift from it or gain a transport-only field that isn't part of
the event `payment.execute` actually consumes; (2) this repo already has a
convention, established by `pay-core`
([ADR-0003](0003-idempotency-and-outbox.md)), that `Idempotency-Key` names
"a caller-supplied key that prevents a retry from repeating an effect" —
reusing the name keeps the concept recognizable across both HTTP surfaces;
(3) it is the standard HTTP idiom for exactly this concept, so no invented
vocabulary is needed.

`202 { eventId, statusUrl }` is **deliberately unchanged**, even on a
deduplicated request. Inventing a `duplicate: true` response flag was
considered and rejected: `inngest.send()`'s response gives no signal
distinguishing "this event just started a new run" from "this event's `id`
matched an existing one" — there is nothing honest to put in that flag. A
caller cannot tell from the trigger response alone whether it deduplicated;
it can only find out by polling `GET /workflows/:eventId` and observing
`queued` forever (see Consequences).

This is explicitly a **weaker** guarantee than pay-core's own
`Idempotency-Key` (`packages/pay-core/src/adapters/http/request.ts`,
ADR-0003): pay-core stores the result of the first call and replays it byte
-for-byte on a same-key retry, and 409s a same-key/different-body retry as a
detected conflict. This trigger-level key does neither — Inngest just drops
the second send's event from ever getting a run, silently, with no
comparison of the two calls' bodies at all. A same-key retry with a
genuinely different body is **not detected as a conflict**; it is simply
discarded.

The existing per-run derivation logic — `stepIdempotencyKey`/`stepOperationId`
and everything built on them inside `payment-execute.ts`/`compensation.ts` —
is completely untouched by this change. This is a new, independent, third
layer of idempotency sitting *above* both of them: trigger-level dedup here,
pay-core-call-level dedup via `stepIdempotencyKey`, and ledger-posting-level
dedup via `stepOperationId`/`fingerprintOf`. None of the three know about
the other two, and none needed to change for this one to be added.

## Alternatives considered and rejected

1. **Inngest's internal `x-inngest-event-id-seed` header.** Manual testing
   confirmed this produces a stable, deterministic ULID for a given seed —
   it would work as a dedup mechanism too. Rejected for now: the resulting
   ULID's embedded timestamp comes from the seed's own bytes, not from
   send-time, which would scatter events to arbitrary points in Inngest's
   dashboard/query ordering by received-time — a real usability regression
   for anyone reading the dashboard chronologically. It is also an
   undocumented internal SDK/server implementation detail, and the public
   `inngest.send()` API (the only one this package calls) exposes no
   argument to set it. Recorded here as a future escape hatch if a *stable,
   predictable* lookup handle (not just dedup) is ever needed — see the
   next alternative for why that need doesn't exist yet.
2. **A `workflow_runs` table mapping a caller key to an event id.** This is
   exactly the escape hatch [ADR-0010](0010-run-status-from-inngest-not-a-workflow-runs-table.md)
   already pre-authorized: "if a future requirement needs a caller-chosen
   correlation id... that is the trigger to build `workflow_runs`". Rejected
   *for now*, not forever: it is disproportionate to the actual problem this
   fix solves (preventing a duplicate financial side-effect), and this ADR
   deliberately narrows ADR-0010's trigger condition to "when a lookup
   handle is needed" — plain dedup, which is all `ApproveIntent` requires,
   does not need one. If a future caller needs to look a run up by its own
   key (not just prevent a duplicate trigger), that is the point to build
   this table, per ADR-0010, not a reason to build it now.
3. **Deriving `stepIdempotencyKey`/`stepOperationId` from the client-supplied
   key instead of `runId`.** Rejected: the client key is optional, so this
   would require two derivation code paths (keyed-by-client-key vs.
   keyed-by-`runId`) inside the single most heavily-tested code in this
   package; it would also invalidate the already-documented, already-accepted
   Replay caveat ("Known limitation: the `runId`-seeded idempotency key under
   Inngest Replay", `packages/durable-ledger/README.md`) in some cases but
   not others depending on whether a key was supplied, which is a worse,
   more confusing limitation than the uniform one that exists today. No
   benefit over fixing dedup at the trigger, where the actual duplicate
   -run problem lives.

## Consequences

- Exactly-once protection against a duplicate HTTP trigger of the *same*
  payment, verified atomic under concurrency by the architect during
  planning and reproduced sequentially above. This is a **bounded**
  guarantee, not an absolute one — it holds only within Inngest's own event
  -retention window. That window was not measured against Inngest Cloud;
  only local dev-server behavior (`inngest/inngest:v1.44.0`) was observed.
- **The "dud handle" consequence, stated bluntly:** a deduplicated caller
  gets back a fresh `202 { eventId, statusUrl }` whose `eventId` will never
  have a run. Polling `GET /workflows/:eventId` for that id reads `queued`
  forever — reproduced above (`01M2Q9HDKRYM85PM45Z32ZZQTQ` above never
  progresses past `{"data":[]}`). A caller — specifically the future
  `ApproveIntent` use-case in `agent-orchestrator` — must treat a
  same-key-retriggered `eventId` that never leaves `queued` as "needs
  reconciliation against the *other* event id from the same key", not as
  "poll harder" or "the engine is slow".
- **No conflict detection.** A same-key retry with a *different* body is
  silently discarded, not rejected. Despite sharing pay-core's header name,
  this is a materially weaker contract than pay-core's own
  `Idempotency-Key` (ADR-0003) — documented here so it is never assumed to
  behave the same way.
- **Cross-caller collision risk, only partially closed.** The dedupe id is
  namespaced by `merchantId` (`payment-execute:<merchantId>:<key>`), so two
  *different* merchants choosing the same "natural" key independently
  (`order-1`, a shared counter, ...) cannot collide with each other. What
  this does **not** solve: the *same* merchant reusing the same key for two
  genuinely different payments still collides — the second payment silently
  becomes a dud handle, with no conflict signal, exactly as described above.
  Callers that mint their own keys (a future `ApproveIntent`, a demo script)
  are responsible for choosing a key that is unique per logical payment
  attempt within one merchant (e.g. derived from the intent id, not a
  constant or a coarse counter).
- **The key is visible in Inngest's dashboard and `GET /v1/events`.** It
  must never be derived from `paymentMethodToken` or any other credential or
  PII — the same boundary [ADR-0012](0012-payment-method-token-is-supplied-not-proposed.md)
  draws around `paymentMethodToken` itself applies here: this key is a
  correlation value, not a place to smuggle a secret into a third-party
  system's logs.
- **Fully backward compatible.** The header is optional; zero existing
  callers of `POST /workflows/payment` send it today, so no existing
  behavior changes for any caller that doesn't opt in.
- **No automated test coverage of the actual Inngest dedup behavior.** This
  repo has no live-Inngest test infrastructure (`payment-execute.test.ts`
  runs against `@inngest/test`'s in-process `InngestTestEngine`, which does
  not model Inngest's real event-ingestion dedup at all). The dedup
  behavior itself — described in Context and reproduced above — was
  verified manually against a real dev server, both by the architect during
  planning and, for this ADR, by re-running the reproduction commands above
  against `inngest/inngest:v1.44.0` via this repo's `docker-compose.yml`
  (the `durable-ledger` service listens on port `3100`, confirmed from
  `docker-compose.yml` rather than assumed). What *is* covered by automated
  tests: that `InngestWorkflowRuns.startPaymentExecute` builds the correct
  `send()` payload (prefixed `id` present iff a key was given, absent
  otherwise, key never leaking into `data`) and that the HTTP layer
  validates/forwards/rejects the header correctly — the Inngest-side dedup
  *guarantee* itself is necessarily out of reach of a unit or in-process
  test.
