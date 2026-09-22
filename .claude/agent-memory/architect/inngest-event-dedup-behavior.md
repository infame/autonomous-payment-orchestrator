---
name: inngest-event-dedup-behavior
description: Empirically verified behavior of Inngest dev-server v1.44.0 event deduplication (payload `id`, the event-id-seed header, concurrent duplicates) and what it means for durable-ledger's trigger endpoint.
metadata:
  type: project
---

Measured 2026-09-17 against `inngest/inngest:v1.44.0` (the image
`docker-compose.yml` already pins) + `inngest@4.20.0`, with a real registered
function, while planning an optional caller-supplied idempotency key for
`POST /workflows/payment`. Every line below was observed, not read in docs.

**Sending the same payload `id` twice dedupes the RUN but not the EVENT.**
Both sends answer `200 {"ids":["<fresh ULID>"]}` with *different* ULIDs, both
events are stored and visible in `GET /v1/events`, and exactly one function
run is created. There is no "skipped"/"duplicate" signal anywhere in the
response.
**Why it matters:** the loser's ULID has **zero runs forever**, and
`InngestWorkflowRuns.findByEventId` maps an empty runs list to
`status: "queued"` — so a deduplicated trigger hands the caller a status URL
that reports `queued` in perpetuity. Worse, in the retry-after-lost-response
case (the exact case the key exists for) the *retry* is always the loser, so
this is the common path, not an edge.
**How to apply:** any design that returns Inngest's `send()` id to a client
must document this dud-handle outcome; it cannot be detected server-side.

**Concurrent duplicates are safe, but "first wins" is not observable.**
Three trials of two simultaneous sends with one `id`: exactly one run every
time. The winner was always the lexicographically smaller (earlier) ULID, but
the HTTP responses come back in arbitrary order, so a caller cannot tell which
of its own ids won — and a retrying process doesn't have the other id at all.

**The `x-inngest-event-id-seed` header makes the event ULID deterministic.**
Two sends carrying an identical seed (`"<millis>,<base64 entropy>"`, built
internally by `Inngest._send`) return the *same* ULID and produce one run.
This is the only mechanism that gives a stable, caller-controlled handle.
**Why it was still rejected for durable-ledger:** the ULID's timestamp is
taken from the seed's millis, so a key-derived seed scatters events to
arbitrary points in time (breaking dashboard ordering and `received_after`
queries), the header is an undocumented SDK↔server detail, and `inngest.send()`
has no public way to set it (only the internal `_send`).

**Other verified facts:** the payload `id` accepts arbitrary strings (600
chars, spaces, `/`, `:`, Cyrillic, even `""` — an empty string means "no id",
so it must never be sent); `GET /v1/events` has no `id` filter, so a client
key cannot be resolved back to its event; `GET /v1/events/<non-ULID>/runs`
still answers `400 Invalid event ID` (ADR-0010's finding, re-confirmed); and
inside a run `event.id` is the caller-supplied id when one was sent, the
internal ULID otherwise (nothing in `payment-execute.ts` reads it today).

Corrects the older "no caller-chosen key is possible" framing: the *money*
half (no second run) is fixable at the trigger boundary; the *observability*
half (a handle that resolves to the run) is not, short of the `workflow_runs`
table [[durable-ledger-pay-core-boundary]]-era ADR-0010 declined to build.
