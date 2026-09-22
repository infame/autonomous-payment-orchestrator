---
name: agent-orchestrator-http-step8-decisions
description: agent-orchestrator step 8 (Hono/config/composition root) design calls — X-Customer-Id as authorization-without-authentication, why the ownership check must precede the use-case call, why §7's merchantId? is dropped rather than plumbed, the `proposed` dead-end caused by Intent.autoApprove being dead code, the uuid-:id trap the in-memory repo hides, and the error-envelope exception for ExecutionRaceLostError.
metadata:
  type: project
---

Decided 2026-09-17 while planning spec step 8 of
`docs/todo/03-agent-orchestrator.md`. Builds on
[[agent-orchestrator-use-case-decisions]] and
[[agent-orchestrator-llm-adapter-decisions]].

**Caller scoping is closed with a required `X-Customer-Id` header on all five
`/intents*` routes — authorization scoping, explicitly NOT authentication.**
**Why:** nothing in this monorepo has a user/session/token concept (pay-core
and durable-ledger HTTP layers have no middleware at all), and `00-overview`
§5 puts the only session-ish mechanism the constellation will ever have
(HMAC grant links → session cookie) in `orchestra`, and scopes it to
*live-LLM budget*, not per-customer data ownership. Inventing an identity
system here would contradict both that boundary and §1's "portfolio, not a
production payment processor". The header closes the class of gap the
use-case headers actually name — "anyone who knows an intent id can act on
someone else's intent" — while leaving "anyone can claim to be any customer"
open and documented, because that one genuinely belongs upstream.
**How to apply:** the header is the SOLE source of caller identity; never
read `customerId` from a request body (that is why `POST /intents`'s body
becomes `{ text }` only). Ownership mismatch returns 404 `intent_not_found`,
never 403 — a 403 confirms the id exists. Do not let a later slice re-open
the gap by adding a body `customerId` "for convenience".

**Spec §7's `POST /intents { merchantId? }` is RESOLVED AS DROPPED, not
deferred again.** **Why:** `LlmReasoningRequest` is `{intentText,
clarificationAnswer}`; plumbing a hint would mean changing the port, both LLM
adapters and the system prompt (steps 3/7 surface) to carry a field that
either gets ignored (silent data loss) or overrides the model — weakening
the very grounding/extraction story §3.3 exists to demonstrate. The merchant
is the LLM's job to extract from intent text.
**How to apply:** record as a spec deviation in the README/ADR. Re-open only
if a second scenario appears where the merchant genuinely is caller-known.

**`Intent.autoApprove` is DEAD CODE — no use-case calls it — so a policy
`allow` parks the intent at `proposed` with no route out.** Verified
2026-09-17 by grep: the only non-test references are doc comments.
**Why it matters:** once routes exist, `proposed` is a user-visible dead end
(`/approve` requires `needs_approval`), and spec §7's "`POST /intents` may
return `executing`", §10's "policy allow → executing → completed" happy-path
test, and §12's DoD are all unreachable. Wiring it is NOT free: `Intent.id`
is minted inside `SubmitIntent`, so ADR-0013's `idempotencyKey = intent.id`
gives zero protection across a retried `POST /intents` — auto-approve turns
an HTTP retry into a second real payment. Closing it needs a caller-supplied
`Idempotency-Key` on `POST /intents` (and, to dedupe the intent row too, a
unique column + migration).
**How to apply:** kept OUT of step 8. Cashed in 2026-09-19 as its own
feature — see [[agent-orchestrator-auto-approve-design]] for the design
(deterministic `Intent.id`, a separate `AutoApproveIntent` use-case, no
migration). Still true either way: never "just call autoApprove" inside a
route handler.

**One error-envelope exception: `ExecutionRaceLostError` → 409 carries
`error.durableLedgerEventId`.** The three packages otherwise share
`{error:{code,message,details?}}` exactly. That eventId is the only handle to
a live money-moving run and nothing can re-derive it (ADR-0010/0013: no
`workflow_runs` table, no key→event lookup), so dropping it to preserve
envelope symmetry loses money-tracing information.
**How to apply:** this is the only permitted field addition. LLM/agent-core
errors get FIXED boundary messages, never `err.message`, because those
reasons can embed vendor/model detail.

**Slice-3 specifics, re-verified against the code 2026-09-19 (after slices
1-2 landed):**
- The ownership pre-check MUST run before the use-case call on all four
  id-addressed routes — not after, and not "only on the not-found path".
  `InvalidIntentStateError`'s message carries the intent's STATUS
  (`Cannot approve an intent in state "rejected"`), so a post-hoc check
  turns 422/409 into an existence+state oracle for a stranger's id. The
  pre-check is `GetIntent` (already in the deps interface) + a
  `customerId` compare, rethrowing the same `IntentNotFoundError`.
  It is also what stops an unauthorized caller from triggering
  `SyncIntentExecution`'s external call + write, or `ApproveIntent`'s
  payment, on someone else's row before being rejected.
- `GET /intents/:id` calls `SyncIntentExecution`, which can throw
  `IntentVersionConflictError`. That must NOT be a 409 on a read:
  `app/sync-intent-execution.ts`'s header explicitly defers this to the
  HTTP layer and recommends a re-read. Catch it in that ONE handler and
  return a fresh `GetIntent` view with 200.
- `:id` must be `z.string().uuid()` at the HTTP layer even though every
  use-case command only says `z.string().min(1)`. `agent.intents.id` is a
  real `uuid` column and `adapters/persistence/drizzle/errors.ts`
  classifies only `23505`, so a non-UUID id reaches Postgres and surfaces
  as a raw `22P02` → generic 500. `InMemoryIntentRepository` returns
  `null` for the same input, so NO in-memory test can catch a missing
  guard. Do not "fix" this by widening the command schemas.
- Agent-core error reachability at the HTTP boundary: `SyncIntentExecution`
  swallows every `AgentCoreClientError` from `getRunStatus`, so the only
  agent-core errors that can reach the mapper come from `ApproveIntent`'s
  `startPaymentWorkflow`. `AgentCoreRunNotFoundError` and
  `AgentCoreRequestCanceledError` are therefore unreachable today (mapped
  for exhaustiveness only).

**`/healthz` stays liveness-only (no DB ping, no LLM ping) — same as
pay-core/durable-ledger.** Pinging Anthropic would make an orchestrator
restart loop burn paid inference, and a DB ping turns a Postgres blip into a
container kill. State this explicitly in the README; it is the kind of thing
a reviewer asks about.

**Slice-4 (composition root + `main.ts`) specifics, verified against the code
2026-09-19:**
- **The `LLM_MODE=live` wiring is TWO objects, not one.**
  `AnthropicLlmClient`'s options take `messages: AnthropicMessagesApi`, never
  a key, so the composition root must do
  `new AnthropicLlmClient({ messages: createAnthropicClient({apiKey, baseUrl?,
  maxRetries?}).messages, model, timeoutMs })`. An implementer who passes
  `apiKey` to `AnthropicLlmClient` (or the whole `Anthropic` client) is
  fighting the deliberate credential boundary in
  [[anthropic-sdk-constraints]] / `anthropic-client.ts`'s header.
  `maxTokens` has no env var and must stay on the adapter default.
- **`resolvePolicyConfig` MUST be called once in the composition root**, even
  though `SubmitIntent`/`AnswerClarification` each call it again internally.
  `config.ts` only shape-checks `POLICY_ALLOWED_CURRENCIES` (regex, non-empty,
  no dupes); the zero-decimal-currency rejection (JPY/KRW/...) lives ONLY in
  `policy/rules.ts` and is module-private there. Without that call, `JPY` is
  a valid env value that fails later, per-request, inside a use-case ctor.
- **NO sibling package has a composition-root test.** `pay-core` and
  `durable-ledger` each have exactly one root-level test (`config.test.ts`).
  A `composition-root.test.ts` here is a deliberate addition, not "matching
  precedent" — justify it as such in review.
- **Do NOT expose a `newId` option on either factory.** `SubmitIntent`'s
  default is `randomUUID`, and the HTTP layer validates `:id` as
  `z.string().uuid()` (see above) — an injected non-UUID id generator makes
  every id-addressed route 400 for reasons no test message explains.
- **Do NOT refactor `app.test.ts`'s `buildApp` onto the new in-memory
  factory.** It exists to inject `neverCalled(...)` doubles per-dependency to
  prove a route never reached a use-case; a composition root that builds all
  six for real cannot express that.
- **Dockerfile + `docker-compose.yml` service + `.github/workflows/ci.yml`
  are STEP 9, not step 8**, even though spec §12's DoD lists them. `start`
  script belongs in slice 4 (the Dockerfile will `CMD` it); nothing else
  container-shaped does. See [[pay-core-docker-runtime]] when step 9 lands.
