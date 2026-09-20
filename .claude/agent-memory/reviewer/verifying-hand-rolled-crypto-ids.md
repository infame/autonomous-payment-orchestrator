---
name: verifying-hand-rolled-crypto-ids
description: How to actually verify a hand-rolled UUIDv5/derived-id helper in this repo (external vectors, not the branch's own test), plus the derived-id review checklist that follows from it.
metadata:
  type: feedback
---

When a branch hand-rolls an id-derivation primitive (UUIDv5 over `node:crypto`
SHA-1, HMAC key derivation, ...), do NOT accept "the test passes" or "the test
cites the RFC vector" as proof — the vector in the test could itself be wrong
or self-referential.

**Why:** on `feat/agent-orchestrator-auto-approve` (2026-09-19)
`packages/agent-orchestrator/src/app/derive-intent-id.ts` was money-safety
load-bearing (the derived `Intent.id` doubles as durable-ledger's ADR-0013
dedup key), so a wrong version/variant nibble would have been a silent
double-payment risk.

**How to apply:** re-implement the algorithm in a throwaway `node -e` script
and check it against vectors the branch does NOT cite. Known-good UUIDv5
values, verifiable from memory / Python's `uuid.uuid5`:
- DNS ns `6ba7b810-9dad-11d1-80b4-00c04fd430c8` + `www.example.org`
  -> `74738ff5-5367-5958-9aee-98fffdcd1876`
- DNS ns + `python.org` -> `886313e1-3b8a-5372-9b90-0c9aee199e5d`
- URL ns `6ba7b811-9dad-11d1-80b4-00c04fd430c8` + `http://python.org/`
  -> `4c565f0d-3f5a-5890-b41b-20cf47701c5e`
Correct bit-twiddling is `b[6] = (b[6] & 0x0f) | 0x50` and
`b[8] = (b[8] & 0x3f) | 0x80` on the first 16 bytes of the SHA-1 digest.

**The rest of the derived-id checklist, in review order:**
1. **Namespace constant** — is it hardcoded and marked "never change this"?
   Changing it re-maps every key and breaks in-flight retries.
2. **Separator ambiguity** — `${a}:${b}` is only injective if the separator
   cannot occur in `a`. Check it against the actual regex
   (`CUSTOMER_ID_PATTERN` is `/^[A-Za-z0-9_-]{1,128}$/`, so `:` is safe).
3. **Two disjoint dedup windows** — a pre-check `findById` (sequential retry,
   saves the LLM/vendor call) AND a catch around `create()` for
   `AlreadyExists` (concurrent race). Both are needed; confirm the
   conflict/replay decision is made in BOTH paths, not just the pre-check.
4. **Unkeyed path unchanged** — the old random-id branch must be untouched,
   and `AlreadyExistsError` must still escape uncaught there (a random
   collision is a genuine server fault, not something to replay).
5. **The residual concurrency window** — two simultaneous keyed POSTs both
   pass the pre-check, both replay/create, and BOTH reach the trigger
   use-case, so two `startPaymentWorkflow` calls go out with the same key.
   Exactly-once then rests entirely on the *downstream* dedup (ADR-0013 /
   Inngest), not on local ordering. Ask whether that is stated in the ADR's
   Consequences; it is easy to leave implicit behind a "retries are handled
   by the pre-check" narrative.
6. **Predictable ids** — say out loud what changes when ids stop being random.
   In this repo the honest answer is "nothing new" only because ADR-0014
   already treats `X-Customer-Id` as spoofable; the ownership comparison is
   the real gate either way.

Related: [[guard-ordering-test-vacuity]] for proving the status guard really
precedes the money-moving call, and [[doc-headers-are-load-bearing]].
