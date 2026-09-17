import type { PaymentExecuteRequested } from "../../workflow/events.js";
import type {
  StartPaymentExecuteOptions,
  WorkflowRunSnapshot,
  WorkflowRuns,
} from "../../ports/workflow-runs.js";

/** Crockford base32 (excludes I, L, O, U), matching `EventIdParam`'s ULID regex — `randomUUID()` would not pass that validation. */
const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomUlidLike(): string {
  let id = "";
  for (let i = 0; i < 26; i++) {
    id += CROCKFORD32[Math.floor(Math.random() * CROCKFORD32.length)];
  }
  return id;
}

/**
 * Test support only — deliberately NOT exported from `src/index.ts`. An
 * in-memory `WorkflowRuns` that records every call and lets a test script
 * exactly what `findByEventId` returns for a given event id: a snapshot, an
 * explicit `null` (unknown event), or a thrown `WorkflowEngineUnavailableError`
 * (or any other error) — whichever the test pre-registers via `script`.
 */
export class FakeWorkflowRuns implements WorkflowRuns {
  readonly startCalls: PaymentExecuteRequested[] = [];
  /** One entry per `startPaymentExecute` call, recording the `idempotencyKey` it was given (if any). */
  readonly startKeys: (string | undefined)[] = [];
  readonly findCalls: string[] = [];
  private readonly scripted = new Map<
    string,
    WorkflowRunSnapshot | null | Error
  >();

  /** Registers what `findByEventId(eventId)` should return/throw. */
  script(eventId: string, result: WorkflowRunSnapshot | null | Error): void {
    this.scripted.set(eventId, result);
  }

  async startPaymentExecute(
    data: PaymentExecuteRequested,
    options?: StartPaymentExecuteOptions,
  ): Promise<{ readonly eventId: string }> {
    this.startCalls.push(data);
    this.startKeys.push(options?.idempotencyKey);
    return { eventId: randomUlidLike() };
  }

  async findByEventId(eventId: string): Promise<WorkflowRunSnapshot | null> {
    this.findCalls.push(eventId);
    const scripted = this.scripted.get(eventId);
    if (scripted === undefined) {
      return null;
    }
    if (scripted instanceof Error) {
      throw scripted;
    }
    return scripted;
  }
}
