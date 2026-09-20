/**
 * RecordingAgentCoreClient: the effect oracle. Every call the system under
 * test makes toward durable-ledger is journaled here, so this is the single
 * source of truth for "did money move" (a `startPaymentWorkflow` entry with
 * a REAL run behind it).
 *
 * It is a deliberate duplicate of `FakeAgentCoreClient`
 * (agent-orchestrator/src/adapters/memory/fake-agent-core-client.ts), which
 * is test support and NOT exported from `@apo/agent-orchestrator`. Duplicating
 * it keeps the harness on the public API only (ADR-0016) and lets the journal
 * grow evals-specific shape (shared call index, snapshots) without touching
 * the SUT.
 *
 * Dedup model (ADR-0013, verified Inngest behavior): every send mints a
 * FRESH eventId; only the first send of a given idempotency key creates a
 * real run, later sends register a permanent "dud" that reads `queued`
 * forever. It is not simplified to same-key -> same-eventId, because the
 * dud's eventId is exactly what the SUT ends up persisting.
 *
 * At runtime it never throws on its own, except AgentCoreRunNotFoundError
 * for an unregistered eventId (as the real client would); that failed lookup
 * is still journaled (snapshot: null). The constructor alone validates its
 * options and throws a plain Error for a bad eventIdPrefix.
 */
import { AgentCoreRunNotFoundError } from "@apo/agent-orchestrator";
import type {
  AgentCoreClient,
  RequestOptions,
  StartPaymentWorkflowOptions,
  StartPaymentWorkflowRequest,
  StartPaymentWorkflowResult,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
} from "@apo/agent-orchestrator";

export interface RecordedStartCall {
  readonly index: number;
  readonly method: "startPaymentWorkflow";
  readonly request: StartPaymentWorkflowRequest;
  readonly idempotencyKey: string | undefined;
  readonly eventId: string;
}

export interface RecordedGetRunStatusCall {
  readonly index: number;
  readonly method: "getRunStatus";
  readonly eventId: string;
  /** null when the eventId was unregistered (the call rejected with AgentCoreRunNotFoundError). */
  readonly snapshot: WorkflowRunSnapshot | null;
}

export type RecordedCoreCall = RecordedStartCall | RecordedGetRunStatusCall;

export function isStartCall(call: RecordedCoreCall): call is RecordedStartCall {
  return call.method === "startPaymentWorkflow";
}

export interface RecordingAgentCoreClientOptions {
  /** Status a freshly created real run reports. Default "queued". */
  readonly runStatus?: WorkflowRunStatus;
  /** Printable ASCII, never blank. Default "evt_rec_". */
  readonly eventIdPrefix?: string;
}

type SettlePatch = Partial<
  Pick<
    WorkflowRunSnapshot,
    "status" | "needsReview" | "startedAt" | "endedAt" | "failureMessage"
  >
>;

export class RecordingAgentCoreClient implements AgentCoreClient {
  readonly name = "recording-agent-core-client";

  private readonly journal: RecordedCoreCall[] = [];
  private readonly runsByEventId = new Map<string, WorkflowRunSnapshot>();
  private readonly realRunKeys = new Set<string>();
  private readonly runStatus: WorkflowRunStatus;
  private readonly eventIdPrefix: string;
  private realRuns = 0;
  private minted = 0;

  constructor(options: RecordingAgentCoreClientOptions = {}) {
    const prefix = options.eventIdPrefix ?? "evt_rec_";
    if (!/^[\x20-\x7e]+$/.test(prefix) || prefix.trim() === "") {
      throw new Error(
        `RecordingAgentCoreClient: eventIdPrefix must be printable ASCII and not blank, got ${JSON.stringify(prefix)}`,
      );
    }
    this.eventIdPrefix = prefix;
    this.runStatus = options.runStatus ?? "queued";
  }

  get calls(): readonly RecordedCoreCall[] {
    return this.journal;
  }

  get startCalls(): readonly RecordedStartCall[] {
    return this.journal.filter(isStartCall);
  }

  /** Real runs only; excludes dud re-sends. */
  get realRunCount(): number {
    return this.realRuns;
  }

  startPaymentWorkflow(
    request: StartPaymentWorkflowRequest,
    opts?: StartPaymentWorkflowOptions,
  ): Promise<StartPaymentWorkflowResult> {
    const idempotencyKey = opts?.idempotencyKey;
    this.minted += 1;
    const eventId = `${this.eventIdPrefix}${String(this.minted)}`;
    const isDuplicate =
      idempotencyKey !== undefined && this.realRunKeys.has(idempotencyKey);

    let status: WorkflowRunStatus = "queued";
    if (!isDuplicate) {
      if (idempotencyKey !== undefined) {
        this.realRunKeys.add(idempotencyKey);
      }
      this.realRuns += 1;
      status = this.runStatus;
    }
    this.runsByEventId.set(eventId, {
      eventId,
      runId: null,
      status,
      startedAt: null,
      endedAt: null,
      needsReview: false,
      failureMessage: null,
    });
    this.journal.push({
      index: this.journal.length,
      method: "startPaymentWorkflow",
      request,
      idempotencyKey,
      eventId,
    });
    return Promise.resolve({ eventId });
  }

  getRunStatus(
    eventId: string,
    _opts?: RequestOptions,
  ): Promise<WorkflowRunSnapshot> {
    const snapshot = this.runsByEventId.get(eventId);
    this.journal.push({
      index: this.journal.length,
      method: "getRunStatus",
      eventId,
      snapshot: snapshot ?? null,
    });
    if (snapshot === undefined) {
      return Promise.reject(
        new AgentCoreRunNotFoundError(
          `RecordingAgentCoreClient: no run registered for eventId "${eventId}"`,
          {
            operation: "get_run_status",
            status: undefined,
            ledgerCode: undefined,
          },
        ),
      );
    }
    return Promise.resolve(snapshot);
  }

  /**
   * Simulates durable-ledger progressing a run. Throws if eventId is unknown.
   * Every minted eventId is registered, duds included, so a dud CAN be
   * settled: that models an ADR-0013-impossible world (a dud reads `queued`
   * forever). Deliberate escape hatch for tests that want to feed the SUT an
   * impossible snapshot; don't use it to fake a second real run.
   */
  settleRun(eventId: string, patch: SettlePatch): void {
    const current = this.runsByEventId.get(eventId);
    if (current === undefined) {
      throw new Error(
        `RecordingAgentCoreClient.settleRun: no run registered for eventId "${eventId}"`,
      );
    }
    this.runsByEventId.set(eventId, { ...current, ...patch });
  }
}
