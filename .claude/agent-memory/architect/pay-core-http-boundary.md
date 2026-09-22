---
name: pay-core-http-boundary
description: Non-obvious constraints on pay-core's Hono HTTP adapter — why a decline is not always 402, why the :id path param must be UUID-validated, and why in-memory wiring needs one idempotency store per operation.
metadata:
  type: project
---

Design constraints found while planning the Hono driving adapter
(`packages/pay-core/src/adapters/http/`, branch `feat/http-adapter`, 2026-09-09).
The spec's §8 error table is correct but under-specifies three things the code
forces.

**1. `ProviderDeclinedError` → 402 does NOT apply to `POST /payments`.**
`CreatePayment.execute` *catches* `ProviderDeclinedError` and calls
`payment.fail(reason)`, persisting a `failed` payment plus an idempotency
record. So an authorize decline is a successful HTTP response carrying
`status: "failed"`, not a 402. 402 can only surface from
capture/refund/cancel, where the provider error propagates.
**Why it matters:** a test that asserts 402 on `POST /payments` will never
pass, and neither `MockProvider` nor `SimulatorProvider` can make authorize
approve while capture declines (the simulator encodes the same directive into
the minted `providerRef`). Route-level 402/503 tests need a small scripted
`PaymentProvider` double.
**How to apply:** keep the mapper keyed on `ProviderError.retryable`
(503 when true, 402 when false) — that is the contract with `durable-ledger`
(see [[pay-core-provider-error-contract]]) — and assert the 201-with-failed
behaviour explicitly so a future refactor can't silently turn it into a 402.

**2. `payments.id` is a Postgres `uuid` column, but the command schemas only
require `z.string().min(1)`.** `GET /payments/not-a-uuid` therefore reaches
`where id = 'not-a-uuid'` and Postgres raises `22P02 invalid_text_representation`
— a 500, not a 404. The in-memory repo hides this completely (a `Map` lookup
just misses), so unit tests will never catch it.
**Why:** the domain deliberately treats the id as an opaque string; the uuid
type is an adapter choice made in the Drizzle schema.
**How to apply:** the HTTP boundary must validate `:id` as a UUID before
calling a use-case. Do not "fix" this by widening the column or loosening the
command schema.

**3. In-memory wiring must use one `InMemoryIdempotencyStore` per operation.**
`PgIdempotencyStore` is constructed with an `operation` discriminator
(`new PgIdempotencyStore(scope, "capture_payment")`) and the table's key is
`(key, operation)`. `InMemoryIdempotencyStore` keys on `key` alone, so a single
shared instance across the five use-cases makes a client that reuses one
`Idempotency-Key` for create *and* capture get the other operation's snapshot
back. Existing use-case tests each build their own store, so this has never
been hit.
**How to apply:** any `createInMemoryPayCore`-style helper builds four separate
stores, mirroring `createPayCore`. Do not add an `operation` field to the port
type to paper over it.

**Toolchain gotcha:** `exactOptionalPropertyTypes: true` is on repo-wide, so
assembling a command with an optional field (`CapturePaymentCommand.amount`)
from a possibly-`undefined` value needs a conditional spread, not
`amount: body.amount`.

See [[pay-core-spec-vs-code]] for the general "code wins over the spec doc"
rule.
