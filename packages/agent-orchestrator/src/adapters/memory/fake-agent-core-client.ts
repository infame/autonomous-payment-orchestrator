import {
  AgentCoreRunNotFoundError,
  type AgentCoreClient,
  type AgentCoreClientError,
  type RequestOptions,
  type StartPaymentWorkflowOptions,
  type StartPaymentWorkflowRequest,
  type StartPaymentWorkflowResult,
  type WorkflowRunSnapshot,
} from "../../ports/agent-core-client.js";

/**
 * Test support only — deliberately NOT exported from `src/index.ts`. Unlike
 * `InMemoryIntentRepository`/`MockLlmClient`, which ARE exported as real
 * demo-mode adapters, there is no legitimate runtime mode where this
 * package fakes the system that actually moves money — faking
 * `AgentCoreClient` outside a test would mean pretending to trigger a real
 * payment. This is an in-process `AgentCoreClient` double for `app/*`
 * use-case tests (`ApproveIntent` and `SyncIntentExecution`), a genuinely
 * different thing from `adapters/http/fake-durable-ledger-server.ts`: that file is a
 * real `node:http` server used to test `HttpDurableLedgerClient` itself
 * (the HTTP adapter's request/response/error-classification wiring); this
 * file has no HTTP in it at all, and exists so a use-case test can assert
 * on `AgentCoreClient` calls directly without going anywhere near a socket.
 *
 * ## Dedup model — mirrors ADR-0013's empirically-verified Inngest behavior
 *
 * `docs/adr/0013-optional-trigger-idempotency-key.md` (in `@apo/durable-ledger`)
 * verified, against a live Inngest dev server, that sending the same
 * `Idempotency-Key` twice produces two distinct `202 {eventId}` responses
 * but exactly ONE real workflow run — the second (or any later) send's
 * `eventId` is a permanent "dud handle" that reads `queued` forever, because
 * no run is ever attached to it. This fake reproduces exactly that shape,
 * not a naive "same key -> same eventId" cache: `startPaymentWorkflow`
 * mints a FRESH `eventId` on every single call, no matter what. Only
 * whether a NEW run gets created behind that fresh id depends on the key:
 * the first call for a given key (or any call with no key at all) creates a
 * real run; every subsequent call for a key already seen registers its
 * fresh eventId as a dud pointing at no run. `runCount` counts real runs
 * only, so a test can assert "at most one real run was ever created" while
 * still observing that multiple distinct eventIds were returned across
 * multiple calls — exactly the residual "handle problem" ADR-0013 accepts
 * and `app/approve-intent.ts`'s header documents.
 */
export class FakeAgentCoreClient implements AgentCoreClient {
  readonly name = "fake-agent-core-client";

  /**
   * Every `startPaymentWorkflow` call, in order, INCLUDING calls that then
   * throw `startError` — recorded before the throw, so a test can prove a
   * call happened (and with which key) even on a failure path. `eventId` is
   * `undefined` on a `startError` call (nothing was minted); otherwise it is
   * the exact, freshly-minted id returned to that call — this is what lets a
   * test distinguish "the second call got back the SAME eventId as the
   * first" (a naive cache — wrong) from "a DIFFERENT, permanently-dud
   * eventId" (the real, ADR-0013-verified behavior this fake models).
   */
  readonly calls: {
    request: StartPaymentWorkflowRequest;
    idempotencyKey: string | undefined;
    eventId: string | undefined;
  }[] = [];

  /**
   * When set, every `startPaymentWorkflow` call throws this instead of
   * registering anything (no eventId minted, no run created). Cleared by
   * the test itself (set back to `undefined`) to simulate the failure
   * clearing on a later retry.
   */
  startError: AgentCoreClientError | undefined;

  /**
   * When set, every `getRunStatus` call throws this instead of returning a
   * snapshot — used by `SyncIntentExecution`'s tests to simulate every
   * `AgentCoreClientError` subclass this port can throw, not only
   * `AgentCoreRunNotFoundError` (the only one this fake produces on its
   * own, for an eventId it has never registered). Cleared by the test
   * itself to simulate the failure clearing on a later call.
   */
  getRunStatusError: AgentCoreClientError | undefined;

  private eventIdSeq = 0;
  /** idempotencyKey -> the eventId of the one REAL run created for that key. */
  private readonly realRunEventIdByKey = new Map<string, string>();
  /** eventId -> its snapshot. Holds both real runs and permanent dud registrations. */
  private readonly runsByEventId = new Map<string, WorkflowRunSnapshot>();
  private realRunCount = 0;

  async startPaymentWorkflow(
    request: StartPaymentWorkflowRequest,
    opts?: StartPaymentWorkflowOptions,
  ): Promise<StartPaymentWorkflowResult> {
    const idempotencyKey = opts?.idempotencyKey;

    if (this.startError !== undefined) {
      // Recorded even on the failure path — no eventId was ever minted.
      this.calls.push({ request, idempotencyKey, eventId: undefined });
      throw this.startError;
    }

    const eventId = this.mintEventId();
    this.calls.push({ request, idempotencyKey, eventId });
    const alreadySeenKey =
      idempotencyKey !== undefined &&
      this.realRunEventIdByKey.has(idempotencyKey);

    if (!alreadySeenKey) {
      // No key, or the first time this key has been seen: a genuine new run.
      if (idempotencyKey !== undefined) {
        this.realRunEventIdByKey.set(idempotencyKey, eventId);
      }
      this.realRunCount += 1;
    }
    // Either way, this fresh eventId gets a "queued" snapshot — a dud reads
    // identically to a freshly-triggered real run; the only observable
    // difference is that a dud never progresses past "queued" (this fake has
    // no scheduler to progress anything at all, so both cases just sit here).
    this.runsByEventId.set(eventId, {
      eventId,
      runId: null,
      status: "queued",
      startedAt: null,
      endedAt: null,
      needsReview: false,
      failureMessage: null,
    });

    return { eventId };
  }

  async getRunStatus(
    eventId: string,
    _opts?: RequestOptions,
  ): Promise<WorkflowRunSnapshot> {
    if (this.getRunStatusError !== undefined) {
      throw this.getRunStatusError;
    }
    const snapshot = this.runsByEventId.get(eventId);
    if (snapshot === undefined) {
      throw new AgentCoreRunNotFoundError(
        `FakeAgentCoreClient: no run registered for eventId "${eventId}"`,
        {
          operation: "get_run_status",
          status: undefined,
          ledgerCode: undefined,
        },
      );
    }
    return snapshot;
  }

  /** Count of REAL runs created so far — excludes dud registrations. Tests use this to assert "only one actual workflow run was ever triggered", even across multiple calls sharing one idempotency key. */
  get runCount(): number {
    return this.realRunCount;
  }

  /** The eventId of the one REAL run registered for `idempotencyKey`, or `undefined` if that key has never been seen. Lets a test assert what got PERSISTED is explicitly NOT this value — i.e. a dud, not the real run's handle. */
  realRunEventIdFor(idempotencyKey: string): string | undefined {
    return this.realRunEventIdByKey.get(idempotencyKey);
  }

  /**
   * Test hook: overwrites the snapshot registered for `eventId` (returned
   * by future `getRunStatus` calls) by merging `patch` onto its current
   * snapshot. Used to simulate durable-ledger/Inngest progressing a run
   * past its initial `queued` snapshot — this fake has no scheduler of its
   * own to do that on its own. Throws if `eventId` was never registered
   * (i.e. `getRunStatus` would otherwise throw `AgentCoreRunNotFoundError`
   * for it), since "settling" a run that never existed doesn't correspond
   * to anything durable-ledger could really do. `patch` is deliberately
   * narrower than `Partial<WorkflowRunSnapshot>` — it excludes `eventId`
   * and `runId`, which are identity/handle fields a "settle" (progressing
   * the SAME run to a later state) must never be able to smuggle in an
   * inconsistent value for.
   */
  settleRun(
    eventId: string,
    patch: Partial<
      Pick<
        WorkflowRunSnapshot,
        "status" | "needsReview" | "startedAt" | "endedAt" | "failureMessage"
      >
    >,
  ): void {
    const current = this.runsByEventId.get(eventId);
    if (current === undefined) {
      throw new Error(
        `FakeAgentCoreClient.settleRun: no run registered for eventId "${eventId}"`,
      );
    }
    this.runsByEventId.set(eventId, { ...current, ...patch });
  }

  private mintEventId(): string {
    this.eventIdSeq += 1;
    return `fake_evt_${String(this.eventIdSeq)}`;
  }
}
