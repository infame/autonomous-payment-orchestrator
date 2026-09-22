---
name: agent-orchestrator-use-case-decisions
description: agent-orchestrator app/* rules — SubmitIntent stopping at `proposed` on an `allow`, one write per use-case, the no-retry conflict policy for AnswerClarification/RejectIntent/ApproveIntent, why ApproveIntent needs BOTH an `executing` short-circuit and Inngest dedup, why its idempotency key being `Intent.id` breaks any future payment-retry feature, why it never re-runs policy, where its paymentMethodToken comes from, how a human reject stays distinguishable without a new column, and the §7 `merchantId?` with nowhere to go.
metadata:
  type: project
---

Decided 2026-09-16 while planning spec step 6 (first slice: `SubmitIntent` +
`GetIntent`) of `docs/todo/03-agent-orchestrator.md`.

**A policy `allow` leaves the `Intent` at `proposed`, and the `allow` verdict
is deliberately NOT persisted.**
**Why:** the only domain edge into `executing` is `Intent.autoApprove`, which
*requires* a `durableLedgerEventId` argument — there is no such id until an
`AgentCoreClient` call happens, and that wiring is a later slice. The domain
has no "record an allow without moving" method and must not grow one: a
`proposed → proposed` self-loop would destroy the current invariant
`policyVerdict !== null ⟹ a policy-driven transition happened`, and would go
dead the moment the execute wiring lands (`autoApprove` sets verdict + eventId
+ status in one mutation). Independently: `dailyRateLimit` is time-dependent,
so policy MUST be re-evaluated at claim/execute time anyway — a stored
`allow` from an hour earlier would be stale, not authoritative. Spec §7 lists
`proposed` as a legal `POST /intents` response status, so this is within
contract, not a shortcut.
**How to apply:** `SubmitIntent`'s reachable status set is exactly
`{needs_clarification, proposed, needs_approval, rejected}`. Return the
verdict alongside the stored view (`{intent, verdict}`), never shadow
`IntentView.policyVerdict` with it. Revisit only if a later slice makes
`proposed`+allow durable beyond one request.

**`SubmitIntent` performs exactly ONE repository write (`create`), after the
LLM call, and carries no optimistic-lock retry loop.**
**Why:** `create()` has no `expectedVersion`, so `IntentVersionConflictError`
is unreachable here and `IntentAlreadyExistsError` is only reachable via a
broken injected id generator — an infrastructure bug to surface, not a domain
outcome to swallow. Calling the LLM *before* the first write is safe (and
differs from the "claim before calling durable-ledger" rule in
[[agent-orchestrator-persistence-decisions]]) precisely because `LlmClient`
moves no money: there is no irreversible side effect to protect with a claim.
The cost is that an `LlmUnavailableError` leaves no row at all — accepted,
since nothing in this slice can resume a stranded `received` intent.
**How to apply:** conflict handling belongs in `AnswerClarification`/
`ApproveIntent` (`findById` + `update(expectedVersion)`), not here. If a
future slice adds LLM retry/resume, that is the trigger to flip to a
persist-then-update shape.

**Spec §7's `POST /intents { merchantId? }` has no destination in the current
port set.**
**Why:** `LlmReasoningRequest` is `{intentText, clarificationAnswer}` only;
`MockLlmClient.defaultMerchantId` is per-instance config, not per-call; and
`Intent` has no `merchantId` field. Accepting it in the command and ignoring
it would be silent data loss.
**How to apply:** leave it out of `SubmitIntentCommand` until someone decides
between (a) `LlmReasoningRequest.merchantIdHint: string | null`, (b) a
per-request `LlmClient` override, or (c) dropping it from §7. Flag it again
when the HTTP slice starts — that is when it actually becomes forced.

**`AnswerClarification` (planned 2026-09-16) propagates
`IntentVersionConflictError` — no retry loop — and asserts the
`needs_clarification` status in the DOMAIN, before the LLM call.**
**Why:** the only writer that can race here is a second concurrent
`AnswerClarification` for the same intent (nothing else in the codebase
mutates a `needs_clarification` intent; `ApproveIntent`/`RejectIntent` act on
`needs_approval`). A retry would re-read a `proposed`/`rejected` intent and
throw `InvalidIntentStateError` anyway, after paying for a second LLM call —
so the retry can only ever convert one error into another. The status guard
must be up front because `Intent.propose` also accepts `received`: relying on
the transition method's own guard would let an answer to a never-asked
question silently succeed (`received → proposed`), *and* would burn an LLM
call before failing.
**How to apply:** conflict → surface as-is (HTTP 409 when the HTTP slice
lands; spec §9 has no row for it — flag then). Wrong status →
`InvalidIntentStateError` (422). Missing → `IntentNotFoundError` (404).

**A human rejection needs NO new field: on a `rejected` intent,
`policyVerdict?.decision === "needs_approval"` is the unique, exact
signature of `Intent.rejectByApprover` (planned 2026-09-16, `RejectIntent`
slice).**
**Why:** `requireApproval` is the ONLY edge into `needs_approval` and always
stores its verdict; `rejectByApprover` does not clear it, and `rejectByPolicy`
(the only other writer of a `reject` verdict) is reachable only from
`proposed`. So all four routes into `rejected` are recoverable from the row
alone: `reject` verdict = policy; `needs_approval` verdict = human;
`policyVerdict === null && proposal.kind === "decline"` = agent (with
`clarificationAnswer` distinguishing the first-pass decline from the
post-clarification one). Note `domain/intent.ts`'s class header currently
*understates* this — it says "neither means a human rejected it", which reads
as `policyVerdict === null`. Spec §7 gives `POST /intents/:id/reject` no
request body (unlike `/clarify`'s `{answer}`), so there is no human-authored
reason text to persist; §8/§13 also refuse a separate policy-audit table.
**How to apply:** do NOT add a `rejectionReason`/note column for a human
reject. If the HTTP slice ever grows `{reason}` in that body, THAT is the
trigger to revisit — and it would need a new nullable column + a bounded
CHECK, mirroring `clarification_answer`.

**`RejectIntent`'s single `update(intent, expectedVersion)` must stay
CONDITIONAL — never "UPDATE ... SET status='rejected' WHERE id=$1" — and its
`IntentVersionConflictError` propagates with no retry.**
**Why:** unlike `AnswerClarification`'s hypothetical self-race, this one has a
real competitor: a future `ApproveIntent` acting on the same `needs_approval`
row. The version check is the ONLY thing making approve/reject mutually
exclusive; an unconditional write would let a reject land on top of a row
already claimed into `executing`, stranding a live durable-ledger workflow
behind a `rejected` intent (money moved, record says no). A retry can never
help either: the re-read row is `executing` or already `rejected`, so it just
converts a conflict into `InvalidIntentStateError` and loses the "someone else
wrote first" signal the operator UI needs. The client already polls
`GET /intents/:id` (spec §7), so a 409 + re-read is the intended recovery.
**How to apply:** conflict → surface as-is. Concurrency tests for this
use-case must force the race with a repo hook that writes out-of-band before
`super.update()`; a plain `Promise.allSettled` of two `execute()` calls is
ordering-fragile here because the await chain has no LLM call in it.

**`ApproveIntent` (planned 2026-09-16) does NOT re-evaluate policy, and is
NOT the third caller of `applyPolicy` — the future auto-approve path inside
`SubmitIntent` is.**
**Why:** three structural blocks, not a preference. (1) `Intent.approve`
takes only a `durableLedgerEventId`, no verdict — there is no slot to store a
fresh one. (2) Overwriting `policyVerdict` would destroy the four-route
rejection discriminator documented in `domain/intent.ts` (on a `rejected`
row, `policyVerdict.decision === "needs_approval"` uniquely means "a human
rejected it"). (3) A fresh `reject` verdict would have nowhere to go:
`rejectByPolicy` is legal only from `proposed`, so the use-case could not act
on it without new domain surface. The human approver IS the gate policy
asked for.
**How to apply:** accept the known staleness — an intent parked at the gate
for a day and then approved bypasses a fresh `dailyRateLimit` check. Revisit
only if approval gates become long-lived; that change needs a new domain
transition (`needs_approval → rejected` by policy) first, not just a call to
`applyPolicy`.

**`ApproveIntent`'s version conflict on the confirm write is NOT the same
event as `RejectIntent`'s, and must not reuse the bare
`IntentVersionConflictError`.** By the time that write runs, a durable-ledger
workflow already exists and the only handle on it is the `eventId` held in
that stack frame — letting the raw conflict propagate discards it and the run
becomes untraceable from our side. Wrap it in an error that carries the
orphaned `eventId` (planned name `ExecutionRaceLostError`). Still no retry —
same reasoning as its siblings. **Re-derived 2026-09-17 against ADR-0013 and
still required, with a now-simpler justification:** ADR-0013 removes the
"maybe two runs" confound, so the conflict now means exactly one thing —
"exactly one run exists and this row will never point at it". The payload is
the point, not the name.

**`ApproveIntent` needs BOTH an `executing` short-circuit AND Inngest's
dedup; they cover disjoint windows and neither is sufficient alone.**
**Why:** (1) spec §10's required test is worded "не создаёт второго *вызова*
durable-ledger" — a *call*, not a second run. Dedup happens inside Inngest,
so relying on it alone still makes the HTTP call and fails the test as
written. (2) spec §6 requires the re-invocation to *return the stored
eventId* (success), while `Intent.approve` would throw
`InvalidIntentStateError` from `executing` — so §6 forces a short-circuit
ahead of the aggregate guard. (3) Most importantly, without it a
re-invocation gets a *dud* eventId back from the dedup and would try to
persist it over the already-correct one. Conversely the short-circuit cannot
replace dedup: in the crash/timeout window nothing was persisted, so there is
no `executing` status to short-circuit on — only the deterministic key stops
a second run there.
**How to apply:** `findById` → `if (status === "executing") return view` →
then let `Intent.approve`'s own guard throw for every other wrong status.
That is the single documented exception to this package's "the aggregate's
guard IS the wrong-status check" convention (`RejectIntent`), and §9's
generic "approve of a non-`needs_approval` intent → 422" yields to §6's
specific rule for `executing` only.

**`idempotencyKey = Intent.id` (raw, unprefixed) means a future "retry this
failed payment" feature is silently deduped into NOTHING.**
**Why:** the key identifies the intent, not the attempt, and ADR-0013 does no
conflict detection — a second trigger under the same key is discarded with no
error signal. Unreachable today (`executing → failed` is terminal, there is
no retry edge), which is why the simple key is correct now.
**How to apply:** if a retry/re-execute transition is ever added, the key MUST
grow an attempt discriminator (`<intentId>:<attempt>`) in the same change —
otherwise the retry looks successful and moves no money. `Intent.id` is a
`randomUUID()`, so it satisfies durable-ledger's `IdempotencyKeyHeader` shape
(`/^[\x21-\x7E]{1,200}$/`) without any encoding.

**`paymentMethodToken` is a REQUIRED constructor argument of `ApproveIntent`,
never a default and never read from `Intent.text`.** ADR-0012 says
config-sourced and never hard-coded in this package; spec §7's
`POST /intents/:id/approve` has no request body, so a per-call override has
nowhere to come from yet. The e2e demo (step 9) will force this question
again, because it needs a per-call `sim.fail_then_succeed.<n>` directive —
resolve it THEN, at the config/HTTP layer, not by deriving a credential from
user-controlled text.

**The policy wiring is extracted to `app/apply-policy.ts`, shared by
`SubmitIntent` and `AnswerClarification`, rather than copied.**
**Why:** the `PolicyContext` must be fed grounding from BOTH `intent.text`
and `intent.clarificationAnswer`. A caller that forgets the answer
hard-rejects (`amount_not_grounded`) an amount the user legitimately supplied
in the clarification round. `ApproveIntent` will be the third caller (policy
MUST be re-evaluated at claim/execute time because `dailyRateLimit` is
time-dependent) — a third hand-rolled copy is exactly where that bug lands.
**How to apply:** any new code path that evaluates policy goes through this
helper. It applies the verdict to the aggregate and performs no repository
write; persistence stays with the use-case (still exactly one write each).

**A second `clarify` from the LLM becomes `rejected`, never an error and
never a second question.** `MockLlmClient` already self-resolves this
(`#resolveClarifyFallthrough`), but a real `AnthropicLlmClient` can still
return `kind:"clarify"` on the second call, so the use-case maps it to
`Intent.declineByAgent(declineProposal(<fixed constant>))` — spec §3.1's
outcome. The synthesized reason never echoes the model's question text.
Losing the original question from `proposal` is spec-sanctioned (§8: the
column stores the *last* `AgentProposal`) and already happens on the happy
path too.

**The §3.3 grounding rule is owned by NEITHER the use-case nor the LLM
adapter alone.** Producing the safe (minimum) interpretation is the LLM side
(`MockLlmClient`'s default `{kind:"payment", selector:"min"}`); *enforcing*
it is `amountMustBeGrounded` inside `evaluatePolicy`. `SubmitIntent` contains
zero grounding logic — its only obligation is to feed `PolicyContext.intentText`
the exact same string the LLM saw (use `intent.text`, which `Intent.submit`
stores raw/untrimmed).
