# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Recruiters and hiring managers evaluating Viacheslav Anosov for backend and
platform engineering roles. They need to understand what he built, assess his
engineering judgment, and decide whether to pursue a hiring conversation.

## Product Purpose

APO — Autonomous Payment Orchestrator — is an engineering prototype that makes
the boundary between model-generated proposals and deterministic payment
execution inspectable. Its purpose is to strengthen the author's hiring
portfolio through working behavior, explicit trade-offs, and evidence that can
be checked. It is not a commercial payment service; real payments are outside
the product's scope.

This record applies to the entire APO repository, including the payment core,
durable workflow and ledger, agent orchestrator, evaluation harness, and public
gateway and demo.

## Positioning

The model proposes an action; an independent deterministic policy decides
whether it may execute. Grounding checks, approval requirements, and limits
remain outside the model. The server selects execution credentials rather than
accepting model-proposed or visitor-supplied credentials.

The public demo uses mock reasoning and a simulated payment provider while
retaining real HTTP calls, PostgreSQL persistence, Inngest workflows, and ledger
posting. This lets reviewers inspect policy enforcement, retry behavior, and
payment and ledger identities without moving real money.

## Operating Context

- The public demo is hosted at <https://infame-apo-demo.fly.dev/>. Its portfolio
  case study is <https://infame.dev/projects/autonomous-payment-orchestrator>.
- Reviewers can run fixed simulated experiments and inspect returned evidence,
  source code, tests, and architectural decisions. The case study supplies the
  author's context and the prototype's limitations.
- `pay-core` supplies the authoritative captured amount. Ledger postings and
  entry IDs establish the accounting record. Inngest supplies workflow status.
  The operation journal is a best-effort diagnostic history, not an
  authoritative payment source or a receipt for each delivery.
- Refreshing evidence performs GET requests only. Starting a new experiment
  clears the current view; execution still requires an explicit payment
  action. An unknown replay outcome never triggers an automatic replay.

## Capabilities and Constraints

The public demo provides four fixed scenarios:

1. Make one simulated $500 payment, then explicitly redeliver that same payment
   ten times, sequentially. Verification requires ten fulfilled receipts,
   unchanged captured amount and payment ID, and the same two original ledger
   entry IDs.
2. Fail the first authorization and first capture call temporarily, then let
   the workflow retry. A completed payment alone does not establish recovery;
   the corresponding failed and returned operations must support that result.
3. Propose $5,000 from a $500 source request. The independent policy blocks the
   unsupported amount before a payment workflow starts.
4. Permanently decline a $600 payment. The expected result requires a failed
   payment record with a confirmed captured amount of zero.

Missing or contradictory evidence remains unknown or unverified. A saved
baseline describes the original observation; it must not substitute for an
unavailable current result. A balanced debit and credit pair does not mean that
nothing was charged.

Sequential replay against a simulator does not establish concurrent-load
behavior, a universal exactly-once guarantee, production readiness, or PCI
compliance. The public deployment does not move real money. Other repository
capabilities and alternative deployment profiles must not be presented as
behavior demonstrated by these four scenarios without separate evidence.

## Evidence on Hand

- `README.md` and the package READMEs describe the repository, service
  boundaries, local operation, and alternative profiles.
- `packages/orchestra/deploy/RUNBOOK.md` documents the public deployment,
  transport budgets, evidence recovery, and verification procedures.
- `packages/orchestra/deploy/smoke.mjs` exercises the real local service stack,
  including payment execution, replay identities, persistence, and service
  boundaries.
- `packages/orchestra/src/adapters/http/experiment-client.test.ts` and
  `packages/orchestra/src/adapters/http/experiment-controller.test.ts` cover result interpretation, incomplete
  evidence, explicit actions, and read-only recovery.
- `packages/agent-orchestrator/src/app/redeliver-intent.test.ts` covers bounded
  sequential delivery. `packages/durable-ledger/src/app/execution-evidence.test.ts`
  covers payment and ledger evidence. Package tests and `packages/agent-evals/`
  provide further behavioral and adversarial checks.
- `docs/adr/` records architectural decisions and their trade-offs. The public
  case study records historical verification with revision-specific context.

Historical test counts and deployment observations belong to their recorded
revisions and environments; they are not standing claims about the current
checkout. Hiring conversion, adoption, and performance benchmarks have not been
established and must not be invented.

## Product Principles

1. Make engineering judgment assessable through observable behavior and
   inspectable evidence, rather than the amount of implementation machinery.
2. Keep model proposals separate from policy authority and execution
   credentials.
3. Preserve uncertainty: distinguish expectations, historical baselines,
   current observations, and verified outcomes.
4. Require deliberate execution actions; reading evidence must never execute
   or silently repeat a payment.
5. State the prototype's limits alongside its demonstrated behavior. Hiring
   appeal must not depend on overstated financial or operational guarantees.

## Metrics we care about

Open: no quantitative hiring-success metric or target has been agreed.

## Roadmap

Open: no product roadmap or release commitments have been agreed.

## Hypothesis log

<!-- Appended by /product after the owner scores a hypothesis. -->

No scored hypotheses are recorded yet.
