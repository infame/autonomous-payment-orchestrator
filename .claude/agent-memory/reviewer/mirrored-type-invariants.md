---
name: mirrored-type-invariants
description: agent-orchestrator hand-mirrors durable-ledger's types and drops their field-level invariants — check every new use-case's reasoning against the PRODUCER's code, not the local mirror.
metadata:
  type: project
---

`packages/agent-orchestrator/src/ports/agent-core-client.ts` re-declares
durable-ledger's `WorkflowRunSnapshot`/`WorkflowRunStatus` by hand (no
`@apo/durable-ledger` import, per ADR-0005/0011). The mirror copies the
*shapes* but routinely drops the producer's per-field JSDoc invariants, and
downstream use-cases then reason from the weakened local copy.

**Why:** on `feat/agent-orchestrator-http-layer` (2026-09-17)
`SyncIntentExecution`'s header argued "`needsReview` is orthogonal to
`status` — a snapshot can in principle report `needsReview: true` alongside
any `status`". The producer says the opposite: durable-ledger's
`ports/workflow-runs.ts` documents "`true` iff `status === "failed"` AND the
output contains NEEDS_REVIEW_MARKER", and
`adapters/inngest/inngest-workflow-runs.ts` computes `needsReview: failed &&
...`. The local mirror's field had no comment at all. Consequence: the only
test pinning the check order used `{status: "completed", needsReview: true}`,
a snapshot the real system can never emit, while the one real case
(`failed` + `needsReview`) went untested — and the code will terminalize a
still-`queued`/`running` intent into the terminal `needs_review` if the flag
ever arrives early.

**How to apply when reviewing:**
- For any `snapshot.<field>` branch in `app/*`, open the producer file in
  `packages/durable-ledger/src/` (ports doc AND the adapter that computes the
  value) before accepting the header's reasoning about that field.
- A test that exercises a field combination the producer cannot emit does not
  cover the production path; ask for the reachable combination too.
- When the mirror drops a producer invariant, the fix is to copy the
  invariant into the mirrored field's JSDoc, not to argue from its absence.

See [[doc-headers-are-load-bearing]] (quantifier drift) and
[[package-readme-status-trio]].

**Resolved (2026-09-18, same branch, commit `2690963`):** the fix is now the
in-repo precedent — the producer's invariant was transcribed verbatim onto
`WorkflowRunSnapshot.needsReview`'s JSDoc in the mirror, and the consumer's
header reframed as fail-safe defense-in-depth. Expect that shape (mirror
carries the invariant; consumer may still check defensively but must not call
it orthogonality) on every future mirrored field.
