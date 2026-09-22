---
name: durable-ledger-invariants
description: Load-bearing constraints for packages/durable-ledger's posting model — operationId must be caller-supplied/deterministic, UNIQUE(operation_id) alone is impossible, balance = credit − debit.
metadata:
  type: project
---

Constraints derived from `docs/todo/02-durable-ledger.md` (§2, §3, §7) while
designing step 1 (the ledger domain model). None of these are obvious from the
doc's prose alone — each came from cross-reading two sections.

**`operationId` must be supplied by the caller and be deterministic — never
`randomUUID()` inside the posting model.**
**Why:** §7 makes `operation_id` the idempotency key of the `post-ledger`
workflow step (UNIQUE constraint), and §2 derives every other idempotency key
deterministically from `hash(runId + ":" + stepName)`. If the domain mints a
random operationId, a retried `post-ledger` step inserts a *second* balanced
group under a different id and the UNIQUE constraint dedupes nothing — the
ledger silently doubles while still passing the zero-sum check.
**How to apply:** `operationId` is a required constructor parameter of the
posting group, validated as a uuid. The workflow (spec step 6) computes it the
same way it computes `Idempotency-Key`.

**`UNIQUE(operation_id)` as literally written in §7 is impossible.**
**Why:** a balanced group always has ≥2 rows sharing one `operation_id`. Only
§7's parenthetical `(operation_id, account, direction)` is satisfiable.
**How to apply:** the domain must therefore reject two entries with the same
`(account, direction)` inside one group (the caller coalesces instead), or
step 2's migration can't enforce idempotency. Design this into step 1 — see
[[pay-core-spec-vs-code]] for the general rule that these column lists run
ahead of, and behind, the code.

**Sign convention: balance = SUM(credit) − SUM(debit)** (§3.4). Under it,
`acquirer_clearing` runs *negative* after a capture. That is correct, not a
bug; it needs an explicit test so nobody "fixes" it later.

**`Money` splits into TWO columns (`amount bigint`, `currency text`); do not
add a `currency` field to `LedgerEntryProps` to "match" the schema.**
**Why:** `Money` is the value object; the row is its serialized form, exactly
as `payments` in pay-core already does it (`amount_authorized` + `currency`).
Adding a domain field would create two sources of truth for the currency of
one entry (`props.currency` vs `props.amount.currency`) that nothing keeps in
sync. The adapter rehydrates with `Money.of(row.amount, row.currency)`.
**How to apply:** the one-currency-per-`operation_id` invariant therefore
stays application-level (`PostingGroup.create` rule 4) — it is cross-row and
not expressible as a per-row CHECK.

**`customer:<id>` is declared in §3.2 but never posted to by any operation in
§3.3** (authorize and cancel produce no entries at all). The account type
should exist, but expect its balance to be permanently zero in the demo.
