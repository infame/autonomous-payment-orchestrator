---
name: doc-headers-are-load-bearing
description: This repo's JSDoc headers are the contract of record and are written before/alongside code, so they drift — in review, check every header claim against the code and tests, not just the code.
metadata:
  type: project
---

Every file in `packages/*/src` carries a long JSDoc header that states the
design contract (nullability, "exactly one write", "never persisted",
rejection sets). Downstream slices are written from those headers, not from
the code, so a header that lies is a real defect, not a nit.

**Why:** on `feat/agent-orchestrator-submit-get-intent` (2026-09-16) the
`SubmitIntentResult.verdict` JSDoc claimed the field is `null` on an `allow`
outcome; the code returned the `AllowVerdict` and its own test asserted the
opposite. Everything compiled, linted and passed. The HTTP layer (next slice)
would have been written against the false claim.

**How to apply when reviewing:**
- For each "always/never/only/null when" sentence in a new or edited header,
  find the line of code and the test that make it true. If no test pins it,
  say so.
- Cross-check the header of the *port* against the header of the new
  implementation — this package states rules in the port file
  (`ports/llm-client.ts`, `ports/intent-repository.ts`) and violates them in
  `app/`.
- Specific recurring rule in `agent-orchestrator`: error messages may contain
  only ids/statuses/enums/thresholds — never `intent.text`,
  `proposal.reasoning/question/reason`, prompts, or vendor response bodies
  (stated in `ports/llm-client.ts` and honoured by
  `domain/agent-proposal.ts`). Copying pay-core's
  `JSON.stringify(_exhaustive)` exhaustiveness default
  (`pay-core/src/adapters/persistence/drizzle/mappers.ts`) into this package
  breaks it, because the stringified value is an LLM-authored object. The
  accepted remedy in this package (2026-09-16, `submit-intent.ts`) is
  `String((exhaustive as AgentProposal).kind)` — cast the `never` back to the
  union and serialize only the discriminator; it typechecks and lints clean.

See [[verify-db-claims-by-running]] for the same lesson on the persistence side.

**Second instance (2026-09-16, `feat/agent-orchestrator-answer-clarification`):**
headers here increasingly argue *why an alternative design would be wrong*
("relying on `propose()`'s guard would silently succeed for a `received`
intent"). That counterfactual is itself a contract claim and is the one most
likely to be untested — the use-case test covered a `proposed` intent, which
both designs reject, so it did not distinguish them. When a header says "X
would be wrong", find the test that exercises exactly X's distinguishing
input, not a neighbouring one.

Related convention worth checking on every new `app/*` use-case: the README
records that `GetIntent` "does not yet scope by caller/customer (deferred to
the future HTTP/auth layer)". A new *mutating* use-case that inherits that gap
must restate it — in this codebase silence in a header reads as "handled".
