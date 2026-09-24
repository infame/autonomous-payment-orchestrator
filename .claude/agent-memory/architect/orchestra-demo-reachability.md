---
name: orchestra-demo-reachability
description: Which beats of 00-overview §8's canonical demo are actually reachable through the live docker-compose stack — the compensation/saga path is NOT, and fail_then_succeed's retry beat fires only once per pay-core container lifetime.
metadata:
  type: project
---

Established 2026-09-22 while designing `packages/orchestra` (05), by reading
`packages/pay-core/src/adapters/simulator/simulator-provider.ts`,
`.../simulator/directives.ts` and
`packages/durable-ledger/src/workflow/compensation.ts`.

**durable-ledger's `route: "compensate"` is UNREACHABLE end-to-end through
the live stack.** It is reachable only in-process, via
`payment-execute-compensation.test.ts`'s `FakeWorkflowStep`.

**Why:** `planUnwind` only compensates on `reason === "terminal_error"` with
a non-empty effect list — in practice "authorize succeeded, then capture
failed terminally". But `SimulatorProvider.authorize` mints
`providerRef = ${encodeDirective(outcome)}._.${uuid}`, i.e. the ref CARRIES
FORWARD the very outcome authorize resolved, and `capture` re-parses that ref
as its own carrier. Only `approve` and `fail_then_succeed` can survive
authorize (`decline` and `timeout` throw before the ref is minted), so
capture can only ever resolve to `approve` (succeeds) or `fail_then_succeed`
(throws `ProviderUnavailableError`, which is *retryable* → `attempts_exhausted`,
which `planUnwind` routes to `needs_review`, never to `compensate`). There is
no directive that yields authorize-ok + capture-terminal, and neither
durable-ledger nor agent-orchestrator exposes a user-initiated cancel
endpoint (`POST /workflows/payment` and `GET` are the only workflow routes).

**How to apply:** do not promise 00-overview §8 beat 7 ("Сценарий отмены →
компенсация откатывает, ledger остаётся сбалансированным") as a live demo
beat without first closing this. The honest live substitute is an
orchestrator-level cancellation — `POST /intents/:id/reject` on a
`needs_approval` intent, which never starts a workflow and leaves the ledger
trivially balanced. Making the saga genuinely live-reachable requires a
pay-core simulator grammar change (a second, post-authorize outcome segment
encoded into the minted ref), which touches a package that is "done".

**`sim.fail_then_succeed.N`'s attempt counter is keyed
`${operation}:${carrier}`, and for `authorize` the carrier is the
server-wide `PAYMENT_METHOD_TOKEN` — a constant.**
**Why:** the counter Map lives on the `SimulatorProvider` instance for the
pay-core process's lifetime, so the *first* workflow after a pay-core boot
consumes the authorize failure budget and every later run authorizes on the
first attempt. `capture`'s carrier is the minted ref, which embeds a fresh
uuid per payment, so capture's fail-once-then-succeed IS fresh every run.
**How to apply:** a rerunnable demo must take `capture` as the
durable-retry beat, not `authorize`. Note also that `parseDirective` reads
only `parts[1]`/`parts[2]`, so `sim.fail_then_succeed.1.<nonce>` parses
identically but gets a distinct counter key — the escape hatch if a
per-run-fresh authorize failure is ever needed, but it requires a per-request
token channel, which `POST /intents` does not have (see
[[orchestra-live-grant-design]]).

**Demo-text trap:** `extractGroundedAmounts` (agent-orchestrator
`policy/grounding.ts`) grounds EVERY numeric literal, so "invoice 42" grounds
4200 minor units and `sim.amount.min` will select $42.00 over the intended
$1,200.00. Demo intent text must contain no reference/date numbers, or must
use `sim.amount.max`.

Related: [[agent-orchestrator-auto-approve-design]],
[[durable-ledger-pay-core-boundary]], [[pay-core-provider-error-contract]].
