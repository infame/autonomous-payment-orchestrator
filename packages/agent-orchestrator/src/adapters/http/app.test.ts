import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import {
  createAgentOrchestratorApp,
  type AgentOrchestratorAppDeps,
} from "./app.js";
import { SubmitIntent } from "../../app/submit-intent.js";
import { GetIntent } from "../../app/get-intent.js";
import { AnswerClarification } from "../../app/answer-clarification.js";
import { ApproveIntent } from "../../app/approve-intent.js";
import { AutoApproveIntent } from "../../app/auto-approve-intent.js";
import { RejectIntent } from "../../app/reject-intent.js";
import { SyncIntentExecution } from "../../app/sync-intent-execution.js";
import { deriveIntentId } from "../../app/derive-intent-id.js";
import { InMemoryIntentRepository } from "../memory/in-memory-intent-repository.js";
import { FakeAgentCoreClient } from "../memory/fake-agent-core-client.js";
import { MockLlmClient } from "../llm/mock-llm-client.js";
import {
  IntentVersionConflictError,
  type StoredIntent,
} from "../../ports/intent-repository.js";
import {
  AgentCoreTimeoutError,
  AgentCoreUnavailableError,
} from "../../ports/agent-core-client.js";
import type { Intent } from "../../domain/intent.js";

const FIXED_CLOCK = () => new Date("2026-07-01T00:00:00Z");
const TOKEN = "pm_test_token";

const ALLOW_TEXT = "Pay the vendor $50.00 for the invoice.";
const NEEDS_APPROVAL_TEXT = "Pay the vendor $600.00 for the invoice.";
const POLICY_REJECT_TEXT = "Pay the vendor $6000.00 for the invoice.";
const CLARIFY_TEXT = "Please help me with a payment. sim.clarify";
const UNAVAILABLE_TEXT = "Please help me with a payment. sim.unavailable";

/**
 * A repository whose NEXT `update()` call throws `IntentVersionConflictError`
 * when armed, then disarms itself — used to deterministically construct a
 * version conflict at a chosen point in a test (the confirming write inside
 * `ApproveIntent`, or the transition write inside `SyncIntentExecution`)
 * without racing two calls with `Promise.allSettled`. Mirrors
 * `approve-intent.test.ts`'s `ThrowOnFirstUpdateRepository` pattern, made
 * reusable for a write that happens partway through a test instead of only
 * the first one.
 */
class ConflictOnDemandRepository extends InMemoryIntentRepository {
  conflictOnNextUpdate = false;
  updateCalls = 0;

  override async update(
    intent: Intent,
    expectedVersion: number,
  ): Promise<StoredIntent> {
    this.updateCalls += 1;
    if (this.conflictOnNextUpdate) {
      this.conflictOnNextUpdate = false;
      throw new IntentVersionConflictError(intent.id, expectedVersion);
    }
    return super.update(intent, expectedVersion);
  }
}

/** A `Pick<X, "execute">`-shaped double that throws if ever called — proves a route/dep was never reached. */
function neverCalled(label: string): {
  execute: (...args: unknown[]) => Promise<never>;
} {
  return {
    execute: (..._args: unknown[]) => {
      throw new Error(`${label} must not be called`);
    },
  };
}

function buildApp(
  overrides?: Partial<AgentOrchestratorAppDeps>,
  repoOverride?: InMemoryIntentRepository,
): {
  app: Hono;
  repo: InMemoryIntentRepository;
  llm: MockLlmClient;
  agentCore: FakeAgentCoreClient;
} {
  const repo = repoOverride ?? new InMemoryIntentRepository();
  const llm = new MockLlmClient();
  const agentCore = new FakeAgentCoreClient();
  const submitIntent = new SubmitIntent(repo, llm, {}, FIXED_CLOCK);
  const getIntent = new GetIntent(repo);
  const answerClarification = new AnswerClarification(
    repo,
    llm,
    {},
    FIXED_CLOCK,
  );
  const approveIntent = new ApproveIntent(repo, agentCore, TOKEN, FIXED_CLOCK);
  const autoApproveIntent = new AutoApproveIntent(
    repo,
    agentCore,
    TOKEN,
    {},
    FIXED_CLOCK,
  );
  const rejectIntent = new RejectIntent(repo, FIXED_CLOCK);
  const syncIntentExecution = new SyncIntentExecution(
    repo,
    agentCore,
    FIXED_CLOCK,
  );
  const deps: AgentOrchestratorAppDeps = {
    submitIntent,
    getIntent,
    answerClarification,
    approveIntent,
    autoApproveIntent,
    rejectIntent,
    syncIntentExecution,
    ...overrides,
  };
  return { app: createAgentOrchestratorApp(deps), repo, llm, agentCore };
}

async function post(
  app: Hono,
  path: string,
  opts: { customerId: string; body?: unknown },
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Customer-Id": opts.customerId,
    },
    // `exactOptionalPropertyTypes` requires `body` to be omitted entirely
    // rather than explicitly set to `undefined` — a conditional spread,
    // not `body: opts.body === undefined ? undefined : ...`, is what
    // `RequestInit["body"]` (no `undefined` in its own type) accepts.
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

async function get(
  app: Hono,
  path: string,
  opts: { customerId: string },
): Promise<Response> {
  return app.request(path, {
    headers: { "X-Customer-Id": opts.customerId },
  });
}

async function postWithKey(
  app: Hono,
  path: string,
  opts: { customerId: string; body?: unknown; idempotencyKey?: string },
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Customer-Id": opts.customerId,
      ...(opts.idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": opts.idempotencyKey }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

interface IntentJSON {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly policyVerdict: { readonly decision: string } | null;
  readonly durableLedgerEventId: string | null;
  readonly updatedAt: string;
}
interface VerdictJSON {
  readonly decision: string;
  readonly reason?: string;
  readonly detail?: string;
}
interface IntentEnvelopeJSON {
  readonly intent: IntentJSON;
  readonly verdict?: VerdictJSON | null;
}
interface ErrorEnvelopeJSON {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: ReadonlyArray<{ path: string; message: string }>;
    readonly durableLedgerEventId?: string;
  };
}

async function seedIntent(
  app: Hono,
  customerId: string,
  text: string,
): Promise<IntentEnvelopeJSON> {
  const res = await post(app, "/intents", { customerId, body: { text } });
  expect(res.status).toBe(201);
  return (await res.json()) as IntentEnvelopeJSON;
}

async function seedNeedsApproval(
  app: Hono,
  customerId = "cust_owner",
): Promise<string> {
  const seeded = await seedIntent(app, customerId, NEEDS_APPROVAL_TEXT);
  expect(seeded.intent.status).toBe("needs_approval");
  return seeded.intent.id;
}

async function seedNeedsClarification(
  app: Hono,
  customerId = "cust_owner",
): Promise<string> {
  const seeded = await seedIntent(app, customerId, CLARIFY_TEXT);
  expect(seeded.intent.status).toBe("needs_clarification");
  return seeded.intent.id;
}

async function seedProposed(
  app: Hono,
  customerId = "cust_owner",
): Promise<string> {
  const seeded = await seedIntent(app, customerId, ALLOW_TEXT);
  expect(seeded.intent.status).toBe("proposed");
  return seeded.intent.id;
}

async function seedRejectedByApprover(
  app: Hono,
  customerId = "cust_owner",
): Promise<string> {
  const id = await seedNeedsApproval(app, customerId);
  const res = await post(app, `/intents/${id}/reject`, { customerId });
  expect(res.status).toBe(200);
  return id;
}

/**
 * Seeds an intent all the way to `executing`, with a completed run already
 * registered on the fake — but never synced onto the row (nothing calls
 * `GET`/`SyncIntentExecution` here). Used specifically to distinguish "the
 * ownership check ran and rejected the call" from "the guarded use-case
 * would have been a no-op for this intent's status anyway" — see the
 * dedicated GET ownership-ordering test below. `SyncIntentExecution` only
 * calls `getRunStatus`/writes when `status === "executing"`; a
 * `needs_approval`/`proposed` seed can never distinguish the two.
 */
async function seedExecutingWithCompletedRun(
  app: Hono,
  agentCore: FakeAgentCoreClient,
  customerId = "cust_owner",
): Promise<string> {
  const id = await seedNeedsApproval(app, customerId);
  const approveRes = await post(app, `/intents/${id}/approve`, { customerId });
  expect(approveRes.status).toBe(200);
  const approveBody = (await approveRes.json()) as IntentEnvelopeJSON;
  const eventId = approveBody.intent.durableLedgerEventId;
  expect(eventId).not.toBeNull();
  agentCore.settleRun(eventId as string, { status: "completed" });
  return id;
}

describe("createAgentOrchestratorApp", () => {
  describe("GET /healthz", () => {
    it("returns 200 with no X-Customer-Id header", async () => {
      const { app } = buildApp();
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("touches ZERO of the seven deps — every dep is a throwing stub", async () => {
      const { app } = buildApp({
        submitIntent: neverCalled("submitIntent"),
        getIntent: neverCalled("getIntent"),
        answerClarification: neverCalled("answerClarification"),
        approveIntent: neverCalled("approveIntent"),
        autoApproveIntent: neverCalled("autoApproveIntent"),
        rejectIntent: neverCalled("rejectIntent"),
        syncIntentExecution: neverCalled("syncIntentExecution"),
      });
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("POST /intents", () => {
    it("happy path: auto-allow stays proposed, ephemeral verdict allow, persisted policyVerdict is null", async () => {
      const { app } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: ALLOW_TEXT },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("proposed");
      expect(body.verdict?.decision).toBe("allow");
      expect(body.intent.policyVerdict).toBeNull();
    });

    it("needs_approval path: 201, persisted policyVerdict is non-null", async () => {
      const { app } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: NEEDS_APPROVAL_TEXT },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("needs_approval");
      expect(body.intent.policyVerdict).not.toBeNull();
    });

    it("policy-reject path: 201 (not 4xx), status rejected, no error key in the body", async () => {
      const { app } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: POLICY_REJECT_TEXT },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON &
        Record<string, unknown>;
      expect(body.intent.status).toBe("rejected");
      expect(body.error).toBeUndefined();
    });

    it("clarify path: 201, status needs_clarification, verdict is null", async () => {
      const { app } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: CLARIFY_TEXT },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("needs_clarification");
      expect(body.verdict).toBeNull();
    });

    it("missing X-Customer-Id: 400 missing_customer_id, zero repo writes, LLM never called", async () => {
      const { app, repo, llm } = buildApp();
      const createSpy = vi.spyOn(repo, "create");
      const reasonSpy = vi.spyOn(llm, "reason");
      const res = await app.request("/intents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ALLOW_TEXT }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.code).toBe("missing_customer_id");
      expect(createSpy).not.toHaveBeenCalled();
      expect(reasonSpy).not.toHaveBeenCalled();
    });

    it.each([
      ["a string with a space", "cust 1", "invalid_customer_id"],
      ["a 129-character string", "a".repeat(129), "invalid_customer_id"],
      ["an empty string", "", "missing_customer_id"],
      ["a string containing a slash", "cust/1", "invalid_customer_id"],
    ])(
      "malformed X-Customer-Id (%s): 400 %s, value never echoed, no LLM call",
      async (_label, headerValue, expectedCode) => {
        const { app, llm } = buildApp();
        const reasonSpy = vi.spyOn(llm, "reason");
        const res = await app.request("/intents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Customer-Id": headerValue,
          },
          body: JSON.stringify({ text: ALLOW_TEXT }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ErrorEnvelopeJSON;
        expect(body.error.code).toBe(expectedCode);
        if (headerValue !== "") {
          expect(JSON.stringify(body)).not.toContain(headerValue);
        }
        expect(reasonSpy).not.toHaveBeenCalled();
      },
    );

    it("body customerId is stripped; the created intent's customerId is the HEADER value, never the body's", async () => {
      const { app } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_real",
        body: { text: ALLOW_TEXT, customerId: "attacker_id" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.customerId).toBe("cust_real");
    });

    it("body merchantId is stripped without error", async () => {
      const { app } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: ALLOW_TEXT, merchantId: "m1" },
      });
      expect(res.status).toBe(201);
    });

    it.each([
      ["missing text", {}],
      ["blank text", { text: "   " }],
      ["over-length text", { text: "a".repeat(10_001) }],
    ])("%s: 400, no repo write", async (_label, body) => {
      const { app, repo } = buildApp();
      const createSpy = vi.spyOn(repo, "create");
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body,
      });
      expect(res.status).toBe(400);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("malformed JSON body: 400 invalid_json", async () => {
      const { app } = buildApp();
      const res = await app.request("/intents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Id": "cust_1",
        },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.code).toBe("invalid_json");
    });

    it("sim.unavailable: 503 llm_unavailable, reason absent from body, repo stays empty", async () => {
      const { app, repo } = buildApp();
      const createSpy = vi.spyOn(repo, "create");
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: UNAVAILABLE_TEXT },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.code).toBe("llm_unavailable");
      expect(JSON.stringify(body)).not.toContain("simulated outage");
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe("POST /intents with Idempotency-Key", () => {
    it("THE HEADLINE REGRESSION TEST: two identical POSTs with the same key never trigger two payments", async () => {
      const { app, agentCore, llm } = buildApp();
      const reasonSpy = vi.spyOn(llm, "reason");
      const customerId = "cust_1";
      const body = { text: ALLOW_TEXT };
      const idempotencyKey = "idem-headline-1";

      const first = await postWithKey(app, "/intents", {
        customerId,
        body,
        idempotencyKey,
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as IntentEnvelopeJSON;
      expect(firstBody.intent.status).toBe("executing");
      expect(firstBody.intent.durableLedgerEventId).not.toBeNull();

      const second = await postWithKey(app, "/intents", {
        customerId,
        body,
        idempotencyKey,
      });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as IntentEnvelopeJSON;

      expect(secondBody.intent.id).toBe(firstBody.intent.id);
      expect(secondBody.intent.durableLedgerEventId).toBe(
        firstBody.intent.durableLedgerEventId,
      );
      // Real-run count: exactly one payment was ever actually triggered.
      expect(agentCore.runCount).toBe(1);
      // Total calls into AgentCoreClient: exactly one — the second POST must
      // short-circuit via SubmitIntent's replay path (finds the existing
      // "executing" row, AutoApproveIntent's own executing short-circuit
      // then fires) and never even ATTEMPT a second startPaymentWorkflow
      // call, per spec §10's "no second call" requirement.
      expect(agentCore.calls).toHaveLength(1);
      // Exactly one LLM call across both requests.
      expect(reasonSpy).toHaveBeenCalledTimes(1);
      // Exactly one logical row: both requests resolved to the SAME intent
      // id (asserted above) — there is no GET /intents list route to count
      // rows directly, but the repository's create() dedup (verified by
      // SubmitIntent's own tests) means two rows could never share one id.
    });

    it("non-vacuity control: two DIFFERENT keys (same customer, same text) yield two distinct intents and two real runs", async () => {
      const { app, agentCore } = buildApp();
      const customerId = "cust_1";
      const body = { text: ALLOW_TEXT };

      const first = await postWithKey(app, "/intents", {
        customerId,
        body,
        idempotencyKey: "idem-control-a",
      });
      const second = await postWithKey(app, "/intents", {
        customerId,
        body,
        idempotencyKey: "idem-control-b",
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = (await first.json()) as IntentEnvelopeJSON;
      const secondBody = (await second.json()) as IntentEnvelopeJSON;

      expect(secondBody.intent.id).not.toBe(firstBody.intent.id);
      expect(agentCore.runCount).toBe(2);
    });

    it("ADR-0014 customer-scoping: same key, DIFFERENT X-Customer-Id -> two distinct intents, two real runs", async () => {
      const { app, agentCore } = buildApp();
      const body = { text: ALLOW_TEXT };
      const idempotencyKey = "idem-shared-across-customers";

      const first = await postWithKey(app, "/intents", {
        customerId: "cust_a",
        body,
        idempotencyKey,
      });
      const second = await postWithKey(app, "/intents", {
        customerId: "cust_b",
        body,
        idempotencyKey,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody = (await first.json()) as IntentEnvelopeJSON;
      const secondBody = (await second.json()) as IntentEnvelopeJSON;

      expect(secondBody.intent.id).not.toBe(firstBody.intent.id);
      expect(agentCore.runCount).toBe(2);
    });

    it("self-healing after a trigger failure: first attempt fails (row stays proposed), retry with the SAME key succeeds, only ONE LLM call total", async () => {
      const { app, agentCore, llm } = buildApp();
      const reasonSpy = vi.spyOn(llm, "reason");
      const customerId = "cust_1";
      const body = { text: ALLOW_TEXT };
      const idempotencyKey = "idem-self-heal";

      agentCore.startError = new AgentCoreUnavailableError(
        "durable-ledger unreachable",
        {
          operation: "start_payment_workflow",
          status: 503,
          ledgerCode: undefined,
        },
      );
      const failed = await postWithKey(app, "/intents", {
        customerId,
        body,
        idempotencyKey,
      });
      expect(failed.status).toBe(503);
      expect(reasonSpy).toHaveBeenCalledTimes(1);

      // The row persists at "proposed" — SubmitIntent's own write already
      // succeeded; only AutoApproveIntent's trigger step failed. Verified
      // via a follow-up GET, addressed by the deterministic derived id
      // (there is no GET /intents list route).
      const derivedId = deriveIntentId(customerId, idempotencyKey);
      const midway = await get(app, `/intents/${derivedId}`, { customerId });
      expect(midway.status).toBe(200);
      const midwayBody = (await midway.json()) as IntentEnvelopeJSON;
      expect(midwayBody.intent.status).toBe("proposed");

      agentCore.startError = undefined;
      const retried = await postWithKey(app, "/intents", {
        customerId,
        body,
        idempotencyKey,
      });
      expect(retried.status).toBe(201);
      const retriedBody = (await retried.json()) as IntentEnvelopeJSON;
      expect(retriedBody.intent.id).toBe(derivedId);
      expect(retriedBody.intent.status).toBe("executing");
      expect(agentCore.runCount).toBe(1);
      // SubmitIntent's own pre-check found the existing "proposed" row on
      // this retry and replayed it (matching text) — no second LLM call.
      // Only AutoApproveIntent's trigger step needed retrying.
      expect(reasonSpy).toHaveBeenCalledTimes(1);
    });

    it("no-key regression: POST without Idempotency-Key behaves exactly as before this slice — proposed forever, zero agent-core calls", async () => {
      const { app, agentCore } = buildApp();
      const res = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: ALLOW_TEXT },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("proposed");
      expect(agentCore.calls).toHaveLength(0);
    });

    it("a body-level idempotencyKey with NO Idempotency-Key header is ignored — identical to no key anywhere: random id, proposed forever, zero agent-core calls, auto-approve never fires", async () => {
      const { app: appWithBodyKey, agentCore: agentCoreWithBodyKey } =
        buildApp();
      const customerId = "cust_1";
      const idempotencyKey = "sneaky-body-key";

      // No "Idempotency-Key" header — `post` (not `postWithKey`) never sets
      // one — but the JSON body carries an `idempotencyKey` field, the
      // second input channel `SubmitIntentBody` must strip.
      const res = await post(appWithBodyKey, "/intents", {
        customerId,
        body: { text: ALLOW_TEXT, idempotencyKey },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;

      // Auto-approve gate stays closed: the intent parks at "proposed",
      // exactly as an unkeyed submission always does — NOT "executing".
      expect(body.intent.status).toBe("proposed");
      expect(agentCoreWithBodyKey.calls).toHaveLength(0);
      // The random-id path was taken, not deriveIntentId(customerId,
      // idempotencyKey) — proving the body value was never read as a key.
      expect(body.intent.id).not.toBe(
        deriveIntentId(customerId, idempotencyKey),
      );

      // Control: byte-identical outcome shape to a request with no key
      // anywhere (only the random id itself legitimately differs).
      const { app: controlApp, agentCore: controlAgentCore } = buildApp();
      const controlRes = await post(controlApp, "/intents", {
        customerId,
        body: { text: ALLOW_TEXT },
      });
      expect(controlRes.status).toBe(201);
      const controlBody = (await controlRes.json()) as IntentEnvelopeJSON;
      expect(controlBody.intent.status).toBe(body.intent.status);
      expect(controlAgentCore.calls).toHaveLength(0);
    });

    it("needs_approval verdict with a key present: no auto-approve triggering, zero agent-core calls", async () => {
      const { app, agentCore } = buildApp();
      const res = await postWithKey(app, "/intents", {
        customerId: "cust_1",
        body: { text: NEEDS_APPROVAL_TEXT },
        idempotencyKey: "idem-needs-approval",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("needs_approval");
      expect(agentCore.calls).toHaveLength(0);
    });

    it.each([
      ["empty", ""],
      ["whitespace-only", "   "],
    ])(
      "header validation: %s Idempotency-Key -> 400 invalid_idempotency_key, neither use-case invoked",
      async (_label, headerValue) => {
        const { app } = buildApp({
          submitIntent: neverCalled("submitIntent"),
          autoApproveIntent: neverCalled("autoApproveIntent"),
        });
        const res = await postWithKey(app, "/intents", {
          customerId: "cust_1",
          body: { text: ALLOW_TEXT },
          idempotencyKey: headerValue,
        });
        expect(res.status).toBe(400);
        const errBody = (await res.json()) as ErrorEnvelopeJSON;
        expect(errBody.error.code).toBe("invalid_idempotency_key");
      },
    );

    it("same key + different text: 409 idempotency_conflict, body contains NEITHER the original nor the new text", async () => {
      const { app } = buildApp();
      const idempotencyKey = "idem-conflict";
      const originalText = "Pay the vendor $50.00 for the invoice.";
      const differentText = "Pay the vendor $51.00 for a different invoice.";

      const first = await postWithKey(app, "/intents", {
        customerId: "cust_1",
        body: { text: originalText },
        idempotencyKey,
      });
      expect(first.status).toBe(201);

      const second = await postWithKey(app, "/intents", {
        customerId: "cust_1",
        body: { text: differentText },
        idempotencyKey,
      });
      expect(second.status).toBe(409);
      const secondBody = (await second.json()) as ErrorEnvelopeJSON;
      expect(secondBody.error.code).toBe("idempotency_conflict");
      const serialized = JSON.stringify(secondBody);
      expect(serialized).not.toContain(originalText);
      expect(serialized).not.toContain(differentText);
    });
  });

  describe("POST /intents/:id/clarify", () => {
    it("happy path from needs_clarification", async () => {
      const { app } = buildApp();
      const id = await seedNeedsClarification(app, "cust_1");
      const res = await post(app, `/intents/${id}/clarify`, {
        customerId: "cust_1",
        body: { answer: "Pay $50.00 to the vendor please." },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).not.toBe("needs_clarification");
    });

    it("wrong status (already proposed): 422", async () => {
      const { app } = buildApp();
      const id = await seedProposed(app, "cust_1");
      const res = await post(app, `/intents/${id}/clarify`, {
        customerId: "cust_1",
        body: { answer: "Pay $50.00 to the vendor please." },
      });
      expect(res.status).toBe(422);
    });

    it.each([
      ["missing answer", {}],
      ["blank answer", { answer: "   " }],
      ["over-length answer", { answer: "a".repeat(2_001) }],
    ])("%s: 400", async (_label, body) => {
      const { app } = buildApp();
      const id = await seedNeedsClarification(app, "cust_1");
      const res = await post(app, `/intents/${id}/clarify`, {
        customerId: "cust_1",
        body,
      });
      expect(res.status).toBe(400);
    });

    it("unknown-but-valid UUID: 404", async () => {
      const { app } = buildApp();
      const res = await post(app, `/intents/${randomUUID()}/clarify`, {
        customerId: "cust_1",
        body: { answer: "hello" },
      });
      expect(res.status).toBe(404);
    });

    it("non-UUID :id: 400 not 500, and the repo is never even queried", async () => {
      const { app } = buildApp({ getIntent: neverCalled("getIntent") });
      const res = await post(app, "/intents/not-a-uuid/clarify", {
        customerId: "cust_1",
        body: { answer: "hello" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /intents/:id/approve", () => {
    it("happy path from needs_approval: 200, executing, durableLedgerEventId set, exactly one agent-core call and one real run", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      const res = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("executing");
      expect(body.intent.durableLedgerEventId).not.toBeNull();
      expect(agentCore.calls).toHaveLength(1);
      expect(agentCore.runCount).toBe(1);
    });

    it("replay: second approve returns 200 with the SAME eventId, still exactly one agent-core call", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      const first = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      const firstBody = (await first.json()) as IntentEnvelopeJSON;

      const second = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as IntentEnvelopeJSON;
      expect(secondBody.intent.durableLedgerEventId).toBe(
        firstBody.intent.durableLedgerEventId,
      );
      expect(agentCore.calls).toHaveLength(1);
    });

    it("approving a proposed intent: 422, zero agent-core calls — the ownership/status guard precedes the money call", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedProposed(app, "cust_1");
      const res = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(422);
      expect(agentCore.calls).toHaveLength(0);
    });

    it("scripted AgentCoreUnavailableError: 503, intent stays needs_approval", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      agentCore.startError = new AgentCoreUnavailableError("unreachable", {
        operation: "start_payment_workflow",
        status: 503,
        ledgerCode: undefined,
      });
      const res = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(503);

      agentCore.startError = undefined;
      const check = await get(app, `/intents/${id}`, { customerId: "cust_1" });
      const checkBody = (await check.json()) as IntentEnvelopeJSON;
      expect(checkBody.intent.status).toBe("needs_approval");
    });

    it("scripted AgentCoreTimeoutError: 504 with the 'may have been accepted' message", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      agentCore.startError = new AgentCoreTimeoutError(
        "timed out",
        {
          operation: "start_payment_workflow",
          status: undefined,
          ledgerCode: undefined,
        },
        5000,
      );
      const res = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.message).toMatch(/may already have been accepted/);
    });

    it("ExecutionRaceLostError end-to-end: repo whose write loses the race -> 409 execution_race_lost, eventId matches the agent-core call this request made", async () => {
      const racyRepo = new ConflictOnDemandRepository();
      const { app, agentCore } = buildApp(undefined, racyRepo);
      const id = await seedNeedsApproval(app, "cust_1");
      racyRepo.conflictOnNextUpdate = true;

      const res = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.code).toBe("execution_race_lost");
      const [call] = agentCore.calls;
      expect(body.error.durableLedgerEventId).toBe(call?.eventId);
    });

    it("non-UUID :id: 400, zero agent-core calls", async () => {
      const { app, agentCore } = buildApp({
        getIntent: neverCalled("getIntent"),
      });
      const res = await post(app, "/intents/not-a-uuid/approve", {
        customerId: "cust_1",
      });
      expect(res.status).toBe(400);
      expect(agentCore.calls).toHaveLength(0);
    });
  });

  describe("POST /intents/:id/reject", () => {
    it("happy path from needs_approval: 200, rejected, policyVerdict.decision is needs_approval (the human-reject discriminator)", async () => {
      const { app } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      const res = await post(app, `/intents/${id}/reject`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("rejected");
      expect(body.intent.policyVerdict?.decision).toBe("needs_approval");
    });

    it("wrong status: 422", async () => {
      const { app } = buildApp();
      const id = await seedProposed(app, "cust_1");
      const res = await post(app, `/intents/${id}/reject`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(422);
    });

    it("unknown UUID: 404", async () => {
      const { app } = buildApp();
      const res = await post(app, `/intents/${randomUUID()}/reject`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(404);
    });

    it("non-UUID :id: 400 not 500, and the repo is never even queried", async () => {
      const { app } = buildApp({ getIntent: neverCalled("getIntent") });
      const res = await post(app, "/intents/not-a-uuid/reject", {
        customerId: "cust_1",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /intents/:id", () => {
    it("non-executing intent: 200 unchanged, agent-core never called", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      const getRunStatusSpy = vi.spyOn(agentCore, "getRunStatus");
      const res = await get(app, `/intents/${id}`, { customerId: "cust_1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("needs_approval");
      expect(getRunStatusSpy).not.toHaveBeenCalled();
    });

    it("executing + a completed run snapshot: 200 status completed — proves this route calls SyncIntentExecution, not bare GetIntent", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      const approveRes = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      const approveBody = (await approveRes.json()) as IntentEnvelopeJSON;
      const eventId = approveBody.intent.durableLedgerEventId;
      expect(eventId).not.toBeNull();
      agentCore.settleRun(eventId as string, { status: "completed" });

      const res = await get(app, `/intents/${id}`, { customerId: "cust_1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("completed");
    });

    it("executing + a scripted agent-core error on the status check: 200 with stale executing, not an error", async () => {
      const { app, agentCore } = buildApp();
      const id = await seedNeedsApproval(app, "cust_1");
      await post(app, `/intents/${id}/approve`, { customerId: "cust_1" });
      agentCore.getRunStatusError = new AgentCoreUnavailableError(
        "unreachable",
        { operation: "get_run_status", status: 503, ledgerCode: undefined },
      );

      const res = await get(app, `/intents/${id}`, { customerId: "cust_1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      expect(body.intent.status).toBe("executing");
    });

    it("version conflict on the sync's internal write: 200 with a re-read view, not 409", async () => {
      const racyRepo = new ConflictOnDemandRepository();
      const { app, agentCore } = buildApp(undefined, racyRepo);
      const id = await seedNeedsApproval(app, "cust_1");
      const approveRes = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_1",
      });
      const approveBody = (await approveRes.json()) as IntentEnvelopeJSON;
      const eventId = approveBody.intent.durableLedgerEventId as string;
      agentCore.settleRun(eventId, { status: "completed" });
      racyRepo.conflictOnNextUpdate = true;

      const res = await get(app, `/intents/${id}`, { customerId: "cust_1" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as IntentEnvelopeJSON;
      // The confirming write lost the race, so the re-read view is the
      // PRE-transition state — still "executing", not "completed". If the
      // conflict hook never actually fired, SyncIntentExecution's own write
      // would have landed and this would read "completed" instead,
      // indistinguishable from the happy path above — that's exactly what
      // the next assertion (the hook disarmed itself) also pins down.
      expect(body.intent.status).toBe("executing");
      expect(racyRepo.conflictOnNextUpdate).toBe(false);
    });

    it("unknown UUID: 404", async () => {
      const { app } = buildApp();
      const res = await get(app, `/intents/${randomUUID()}`, {
        customerId: "cust_1",
      });
      expect(res.status).toBe(404);
    });

    it("non-UUID: 400", async () => {
      const { app } = buildApp({ getIntent: neverCalled("getIntent") });
      const res = await get(app, "/intents/not-a-uuid", {
        customerId: "cust_1",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("customer scoping", () => {
    const ROUTES: ReadonlyArray<{
      readonly name: string;
      readonly seed: (app: Hono) => Promise<string>;
      readonly call: (
        app: Hono,
        id: string,
        customerId: string,
      ) => Promise<Response>;
    }> = [
      {
        name: "GET",
        seed: (app) => seedNeedsApproval(app, "cust_owner"),
        call: (app, id, customerId) =>
          get(app, `/intents/${id}`, { customerId }),
      },
      {
        name: "clarify",
        seed: (app) => seedNeedsClarification(app, "cust_owner"),
        call: (app, id, customerId) =>
          post(app, `/intents/${id}/clarify`, {
            customerId,
            body: { answer: "Pay $50.00 to the vendor please." },
          }),
      },
      {
        name: "approve",
        seed: (app) => seedNeedsApproval(app, "cust_owner"),
        call: (app, id, customerId) =>
          post(app, `/intents/${id}/approve`, { customerId }),
      },
      {
        name: "reject",
        seed: (app) => seedNeedsApproval(app, "cust_owner"),
        call: (app, id, customerId) =>
          post(app, `/intents/${id}/reject`, { customerId }),
      },
    ];

    it.each(ROUTES.map((r) => [r.name, r] as const))(
      "%s: wrong owner -> 404, identical to a never-created UUID's 404 (no existence oracle)",
      async (_name, route) => {
        const { app } = buildApp();
        const id = await route.seed(app);

        const wrongOwnerRes = await route.call(app, id, "cust_intruder");
        expect(wrongOwnerRes.status).toBe(404);
        const wrongOwnerBody =
          (await wrongOwnerRes.json()) as ErrorEnvelopeJSON;

        const neverCreatedId = randomUUID();
        const unknownRes = await route.call(
          app,
          neverCreatedId,
          "cust_intruder",
        );
        expect(unknownRes.status).toBe(404);
        const unknownBody = (await unknownRes.json()) as ErrorEnvelopeJSON;

        // `IntentNotFoundError`'s message echoes back whatever id the
        // caller supplied in the URL — not an existence oracle, since the
        // caller already knows that id. Normalizing each body's own id to a
        // placeholder before comparing proves everything ELSE (status, code,
        // message template, JSON shape) is byte-identical between "belongs
        // to someone else" and "genuinely doesn't exist".
        const normalize = (body: unknown, requestedId: string): unknown =>
          JSON.parse(
            JSON.stringify(body).split(requestedId).join("<id>"),
          ) as unknown;
        expect(normalize(wrongOwnerBody, id)).toEqual(
          normalize(unknownBody, neverCreatedId),
        );
      },
    );

    it.each(ROUTES.map((r) => [r.name, r] as const))(
      "%s: wrong owner -> no side effects (zero agent-core calls, row untouched, LLM never called)",
      async (_name, route) => {
        const { app, repo, llm, agentCore } = buildApp();
        const id = await route.seed(app);
        const before = await repo.findById(id);

        const reasonSpy = vi.spyOn(llm, "reason");
        const res = await route.call(app, id, "cust_intruder");
        expect(res.status).toBe(404);

        const after = await repo.findById(id);
        expect(after?.intent.status).toBe(before?.intent.status);
        expect(after?.intent.updatedAt).toEqual(before?.intent.updatedAt);
        expect(agentCore.calls).toHaveLength(0);
        expect(reasonSpy).not.toHaveBeenCalled();
      },
    );

    it("wrong owner on a state the route would reject anyway (approve on an already-rejected intent): 404, not 422 — the direct state-oracle regression test", async () => {
      const { app } = buildApp();
      const id = await seedRejectedByApprover(app, "cust_owner");

      const res = await post(app, `/intents/${id}/approve`, {
        customerId: "cust_intruder",
      });
      expect(res.status).toBe(404);
    });

    it("GET: wrong owner on an EXECUTING intent -> 404, and the guarded call (getRunStatus + write) never happens — proves the ownership check runs BEFORE SyncIntentExecution, not merely that SyncIntentExecution is a no-op for a non-executing intent", async () => {
      // The shared ROUTES table above seeds GET with a needs_approval
      // intent, for which SyncIntentExecution ALREADY returns early with no
      // client call and no write (see sync-intent-execution.ts:146-149) —
      // so a no-side-effects assertion against that seed can't tell "the
      // ownership check ran first" apart from "the guarded call was a
      // no-op regardless of check order". Only an EXECUTING intent, where
      // the guarded call actually does something (an external getRunStatus
      // call, and potentially a write), can distinguish the two. This is
      // deliberately a standalone test, not a ROUTES entry, because the
      // other three routes' own no-side-effects test already covers them
      // adequately with the shared needs_approval seed.
      const { app, repo, agentCore } = buildApp();
      const id = await seedExecutingWithCompletedRun(
        app,
        agentCore,
        "cust_owner",
      );
      const before = await repo.findById(id);
      expect(before?.intent.status).toBe("executing");

      const getRunStatusSpy = vi.spyOn(agentCore, "getRunStatus");
      const res = await get(app, `/intents/${id}`, {
        customerId: "cust_intruder",
      });
      expect(res.status).toBe(404);

      expect(getRunStatusSpy).not.toHaveBeenCalled();
      // Only the approve call from seeding — no second agent-core call from
      // this GET.
      expect(agentCore.calls).toHaveLength(1);
      const after = await repo.findById(id);
      expect(after?.intent.status).toBe("executing");
      expect(after?.intent.updatedAt).toEqual(before?.intent.updatedAt);
    });

    it.each(ROUTES.map((r) => [r.name, r] as const))(
      "%s: correct owner -> NOT 404 (control case)",
      async (_name, route) => {
        const { app } = buildApp();
        const id = await route.seed(app);
        const res = await route.call(app, id, "cust_owner");
        expect(res.status).not.toBe(404);
      },
    );

    it("end-to-end: an intent created by customer A is invisible to B via GET, but visible to A", async () => {
      const { app } = buildApp();
      const seeded = await seedIntent(app, "cust_a", ALLOW_TEXT);

      const asB = await get(app, `/intents/${seeded.intent.id}`, {
        customerId: "cust_b",
      });
      expect(asB.status).toBe(404);

      const asA = await get(app, `/intents/${seeded.intent.id}`, {
        customerId: "cust_a",
      });
      expect(asA.status).toBe(200);
    });
  });

  describe("envelope / misc", () => {
    it("unknown path: 404 not_found", async () => {
      const { app } = buildApp();
      const res = await app.request("/some/nonexistent/route");
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.code).toBe("not_found");
    });

    it("wrong HTTP method on a known path: 404 not_found", async () => {
      const { app } = buildApp();
      const res = await app.request("/intents", { method: "DELETE" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorEnvelopeJSON;
      expect(body.error.code).toBe("not_found");
    });

    it("every route's success body has the intent under an 'intent' key, and approve/reject/GET carry NO verdict key at all", async () => {
      const { app } = buildApp();

      const submitRes = await post(app, "/intents", {
        customerId: "cust_1",
        body: { text: ALLOW_TEXT },
      });
      const submitBody = (await submitRes.json()) as Record<string, unknown>;
      expect(Object.keys(submitBody).sort()).toEqual(["intent", "verdict"]);

      const clarifyId = await seedNeedsClarification(app, "cust_1");
      const clarifyRes = await post(app, `/intents/${clarifyId}/clarify`, {
        customerId: "cust_1",
        body: { answer: "Pay $50.00 to the vendor please." },
      });
      const clarifyBody = (await clarifyRes.json()) as Record<string, unknown>;
      expect(Object.keys(clarifyBody).sort()).toEqual(["intent", "verdict"]);

      const approveId = await seedNeedsApproval(app, "cust_1");
      const approveRes = await post(app, `/intents/${approveId}/approve`, {
        customerId: "cust_1",
      });
      const approveBody = (await approveRes.json()) as Record<string, unknown>;
      expect(Object.keys(approveBody)).toEqual(["intent"]);
      expect("verdict" in approveBody).toBe(false);

      const rejectId = await seedNeedsApproval(app, "cust_1");
      const rejectRes = await post(app, `/intents/${rejectId}/reject`, {
        customerId: "cust_1",
      });
      const rejectBody = (await rejectRes.json()) as Record<string, unknown>;
      expect(Object.keys(rejectBody)).toEqual(["intent"]);
      expect("verdict" in rejectBody).toBe(false);

      const getRes = await get(app, `/intents/${rejectId}`, {
        customerId: "cust_1",
      });
      const getBody = (await getRes.json()) as Record<string, unknown>;
      expect(Object.keys(getBody)).toEqual(["intent"]);
      expect("verdict" in getBody).toBe(false);
    });
  });
});
