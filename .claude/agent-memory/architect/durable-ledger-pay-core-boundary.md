---
name: durable-ledger-pay-core-boundary
description: Constraints on durable-ledger's HTTP client for pay-core — why a real in-process pay-core can't be used in its tests, and the exactly-once hole a retryable timeout leaves open.
metadata:
  type: project
---

Found while planning step 4 of `docs/todo/02-durable-ledger.md` (the typed
pay-core HTTP client), 2026-09-11.

**Testing durable-ledger's client against a *real* in-process pay-core is
blocked by two independent things, not one.**
**Why:** (1) `packages/pay-core/package.json` still has no
`main`/`types`/`exports`, so it isn't importable as a workspace dependency
(ADR-0005 already records this); and (2) even if it were, the three failure
modes the client most needs to test can't be produced through it —
`SimulatorProvider` encodes its directive into the minted `providerRef`, so
`sim.decline.*` declines at *authorize* (201 + `status: "failed"`, see
[[pay-core-http-boundary]] §1) and can never yield a 402 on capture; a 500
and a client-side timeout have no directive at all. pay-core's own 402/503
route tests use a `ScriptedProvider` local to `app.test.ts`, which is not
exported either.
**How to apply:** test the client against a small fake pay-core HTTP server
(`node:http`, ephemeral port) that reproduces the wire contract read off
`packages/pay-core/src/adapters/http/error-mapper.ts`. Real sockets, real
`fetch`, no Docker, no compile-time coupling. The honest end-to-end check
belongs later, over the network against the pay-core *container* that
`docker-compose.yml` already defines — not via an import.

**A retryable timeout on `POST /payments` is not exactly-once, and no client
can fix it.**
**Why:** `CreatePayment` calls the provider and only then writes the payment
+ idempotency record. If the provider authorized but the transaction failed
(or the response was lost), no idempotency record exists, so a retry with the
*same* `Idempotency-Key` re-runs authorize and places a **second hold** under
a new `paymentId` — see the related constraint in
[[pay-core-provider-error-contract]]. Capture/refund/cancel don't have this
hole in the same way (the second call is still a real second effect if the
first one's record was lost, but the provider ref is stable).
**How to apply:** don't claim exactly-once for authorize in
`durable-ledger`'s README defense-in-depth section without this caveat; the
guarantee is "at-most-one *recorded* payment", not "at-most-one hold". If it
ever needs closing, the fix is in pay-core (persist an in-flight intent
before calling the provider), not in the client or the retry policy.
