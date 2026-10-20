import { randomUUID } from "node:crypto";
import type {
  ExecutionAttempt,
  ExecutionJournal,
} from "../ports/execution-journal.js";
import { PayCoreClientError } from "../ports/pay-core-errors.js";

/** Bound telemetry latency even if its adapter hangs. Rejections are consumed. */
export async function journalBestEffort(
  action: () => Promise<unknown>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 150);
      }),
    ]);
  } catch {
    /* Observation failure must never reach business retry/compensation. */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function recordAttempt<T>(
  journal: ExecutionJournal | undefined,
  context: Pick<
    ExecutionAttempt,
    | "runId"
    | "eventId"
    | "step"
    | "phase"
    | "operationId"
    | "idempotencyKey"
    | "paymentId"
  >,
  effect: () => Promise<T>,
  paymentId: (result: T) => string | null,
): Promise<T> {
  if (journal === undefined) return effect();
  const id = randomUUID();
  await journalBestEffort(() =>
    journal.start({
      ...context,
      id,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: "started",
      errorCode: null,
    }),
  );
  let result: T;
  try {
    result = await effect();
  } catch (error) {
    const safeCodes = new Set([
      "pay_core_network_error",
      "pay_core_timeout",
      "pay_core_canceled",
      "pay_core_bad_request",
      "pay_core_declined",
      "pay_core_not_found",
      "pay_core_idempotency_conflict",
      "pay_core_illegal_state",
      "pay_core_unavailable",
      "pay_core_unexpected_response",
      "pay_core_malformed_response",
    ]);
    const errorCode =
      error instanceof PayCoreClientError && safeCodes.has(error.code)
        ? error.code
        : "operation_failed";
    await journalBestEffort(() =>
      journal.finish(id, {
        paymentId: context.paymentId,
        endedAt: new Date().toISOString(),
        outcome: "failed",
        errorCode,
      }),
    );
    throw error;
  }
  await journalBestEffort(() =>
    journal.finish(id, {
      paymentId: paymentId(result),
      endedAt: new Date().toISOString(),
      outcome: "succeeded",
      errorCode: null,
    }),
  );
  return result;
}
