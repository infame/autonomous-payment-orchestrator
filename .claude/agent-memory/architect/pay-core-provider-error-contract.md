---
name: pay-core-provider-error-contract
description: Why pay-core's provider errors (declined vs unavailable) are plain Errors in the port file, not DomainError subclasses — and the non-obvious retry constraint that CreatePayment regenerates the paymentId on retry.
metadata:
  type: project
---

The 402-vs-503 split (`ProviderDeclinedError` vs `ProviderUnavailableError` in
`packages/pay-core/src/ports/payment-provider.ts`) is a **cross-repo contract**
with the future `durable-ledger` repo, which builds its retry policy on it —
not a cosmetic error taxonomy.

**Why they are not `DomainError` subclasses:** `DomainError` (with its machine
`code`) is the vocabulary of *aggregate invariant violations* — the `Payment`
aggregate throws those. Provider errors and `IdempotencyConflictError` come
from the outside world across a port boundary; both already live in their own
port file as plain `Error` subclasses with `this.name` set. Spec
§8 of `docs/todo/01-pay-core.md` implies all errors inherit `DomainError`, but
the code disagrees consistently across two port files, so the code wins
(see [[pay-core-spec-vs-code]]).

**Non-obvious constraint — attempt counters must not be keyed on `paymentId`:**
`CreatePayment` mints a fresh `randomUUID()` per call and, on a transient
provider failure, throws *before* `repo.save()` and *before* the idempotency
record is written. A retry of the same logical request therefore arrives with a
**different `paymentId`**. Any "fail the first N attempts" simulator or retry
bookkeeping keyed on `paymentId` never advances and loops forever. Key on
`paymentMethodToken` (stable across retries, already on `AuthorizeParams`) for
authorize, and on `providerRef` for capture/refund/cancel.

**How to apply:** the flip side of that same behaviour is a good property worth
keeping — a transient failure persists *nothing*, so the whole use-case is
safe to re-run; a terminal decline persists a `failed` payment plus an
idempotency record, so a retry returns the same snapshot. Preserve that
asymmetry in any use-case change, and assert it in tests rather than only
asserting the thrown type.
