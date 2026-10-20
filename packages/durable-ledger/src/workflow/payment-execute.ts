import { recordAttempt } from "./record-attempt.js";
import type { ExecutionJournal } from "../ports/execution-journal.js";
import type { Inngest } from "inngest";
import { NonRetriableError } from "inngest";
import type {
  CapturePaymentResponse,
  CreatePaymentResponse,
  PayCoreClient,
} from "../ports/pay-core-client.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { DecideRetryOptions } from "./retry-policy.js";
import { resolveRetryPolicy } from "./retry-policy.js";
import { PostingGroup } from "../domain/entry.js";
import { Money } from "../domain/money.js";
import {
  paymentExecuteRequested,
  type PaymentExecuteRequested,
} from "./events.js";
import { stepIdempotencyKey } from "./idempotency-key.js";
import { stepOperationId } from "./operation-id.js";
import {
  rethrowForInngest,
  inngestRetriesFor,
  stepFailureOf,
} from "./inngest-errors.js";
import type { WorkflowStep } from "./workflow-step.js";
import {
  planUnwind,
  runUnwind,
  compensatedFailureMessage,
  needsReviewMessage,
  type CompletedEffect,
} from "./compensation.js";

export interface PaymentExecuteRunDeps {
  readonly journal?: ExecutionJournal;
  readonly payCore: PayCoreClient;
  readonly ledger: LedgerRepository;
  readonly retry?: DecideRetryOptions;
}

export interface PaymentExecuteDeps extends PaymentExecuteRunDeps {
  readonly inngest: Inngest;
}

/**
 * JSON-safe by construction — step.run/function output is `Jsonify`'d by
 * Inngest (a returned `Date` becomes a string, etc.), so every field here
 * must already be a JSON-primitive shape.
 */
export interface PaymentExecuteResult {
  readonly paymentId: string;
  readonly status: string;
  readonly currency: string;
  readonly capturedAmount: number;
  readonly ledgerOperationId: string;
  readonly ledgerOutcome: "posted" | "already_posted";
}

export const PAYMENT_EXECUTE_FUNCTION_ID = "payment-execute";
export const PAYMENT_EXECUTE_STEPS = [
  "authorize",
  "capture",
  "post-ledger",
] as const;

/**
 * The `payment.execute` workflow (spec §4.2): authorize -> capture -> post a
 * `forCapture` ledger entry, each step idempotency-keyed on
 * `(runId, stepName)` so a crash between steps resumes from the unfinished
 * one instead of double-charging. A terminal failure or exhausted retries no
 * longer just fails the function — it routes through `planUnwind`
 * (`./compensation.js`) to decide whether to compensate what already
 * succeeded (`runUnwind`) or send the run to `needs_review` untouched (spec
 * §7/§8). See "Compensations (sagas)" in this package's README for the full
 * decision table.
 *
 * Independent of Inngest's own `ctx.step` — driven against the narrower
 * `WorkflowStep` (`./workflow-step.js`) instead — because `@inngest/test`'s
 * `InngestTestEngine` cannot execute any handler code after a step fails
 * (see `docs/adr/0009-compensation-routing-and-the-workflow-step-seam.md`),
 * which makes the compensation path added here untestable through that
 * harness. `payment-execute-compensation.test.ts` drives this function
 * directly via `FakeWorkflowStep` for exactly that reason;
 * `payment-execute.test.ts` keeps driving `createPaymentExecuteFunction`
 * through `InngestTestEngine` for the happy path and for forward-path
 * failures that occur before any effect exists to compensate.
 */
export async function runPaymentExecute(
  step: WorkflowStep,
  ctx: {
    readonly eventId?: string;
    readonly runId: string;
    readonly attempt: number;
    readonly data: PaymentExecuteRequested;
  },
  deps: PaymentExecuteRunDeps,
): Promise<PaymentExecuteResult> {
  const { runId, attempt, data } = ctx;
  const { amount, currency, paymentMethodToken, merchantId } = data;
  const effects: CompletedEffect[] = [];

  try {
    const authorized: CreatePaymentResponse = await step.run(
      "authorize",
      async () => {
        try {
          return await recordAttempt(
            deps.journal,
            {
              runId,
              eventId: ctx.eventId ?? null,
              step: "authorize",
              phase: "workflow",
              paymentId: null,
              operationId: null,
              idempotencyKey: stepIdempotencyKey(runId, "authorize"),
            },
            () =>
              deps.payCore.createPayment(
                { amount, currency, paymentMethodToken },
                { idempotencyKey: stepIdempotencyKey(runId, "authorize") },
              ),
            (result) => result.id,
          );
        } catch (error) {
          rethrowForInngest("authorize", error, attempt + 1, deps.retry);
        }
      },
    );

    if (authorized.status !== "authorized") {
      // The 201-with-status:"failed" case (pay-core README's documented
      // gotcha, mirrored in this package's own README under "Talking to
      // pay-core"). This is a clean terminal failure, NOT a place to
      // compensate — authorize never succeeded, so there is no effect to
      // unwind (`effects` is still empty, so the catch block below takes
      // the `no_effects` route and rethrows this verbatim).
      throw new NonRetriableError(
        `Payment ${authorized.id} failed to authorize: status=${authorized.status}`,
      );
    }
    effects.push({ kind: "authorized", paymentId: authorized.id });

    const captured: CapturePaymentResponse = await step.run(
      "capture",
      async () => {
        try {
          return await recordAttempt(
            deps.journal,
            {
              runId,
              eventId: ctx.eventId ?? null,
              step: "capture",
              phase: "workflow",
              paymentId: authorized.id,
              operationId: null,
              idempotencyKey: stepIdempotencyKey(runId, "capture"),
            },
            () =>
              deps.payCore.capturePayment(
                { paymentId: authorized.id },
                { idempotencyKey: stepIdempotencyKey(runId, "capture") },
              ),
            (result) => result.id,
          );
        } catch (error) {
          rethrowForInngest("capture", error, attempt + 1, deps.retry);
        }
      },
    );
    effects.push({
      kind: "captured",
      paymentId: captured.id,
      amount: captured.capturedAmount,
      currency: captured.currency,
    });

    const ledgerResult = await step.run("post-ledger", async () => {
      const operationId = stepOperationId(runId, "post-ledger");
      try {
        const group = PostingGroup.forCapture({
          operationId,
          paymentId: captured.id,
          merchantId,
          amount: Money.of(captured.capturedAmount, captured.currency),
        });
        const result = await recordAttempt(
          deps.journal,
          {
            runId,
            eventId: ctx.eventId ?? null,
            step: "post-ledger",
            phase: "workflow",
            paymentId: captured.id,
            operationId,
            idempotencyKey: null,
          },
          () => deps.ledger.post(group),
          () => captured.id,
        );
        return { operationId, outcome: result.outcome };
      } catch (error) {
        rethrowForInngest("post-ledger", error, attempt + 1, deps.retry);
      }
    });
    effects.push({
      kind: "ledger-posted",
      paymentId: captured.id,
      operationId: ledgerResult.operationId,
    });

    return {
      paymentId: captured.id,
      status: captured.status,
      currency: captured.currency,
      capturedAmount: captured.capturedAmount,
      ledgerOperationId: ledgerResult.operationId,
      ledgerOutcome: ledgerResult.outcome,
    } satisfies PaymentExecuteResult;
  } catch (error) {
    const failure = stepFailureOf(error);
    const plan = planUnwind({ reason: failure.reason, effects });

    if (plan.route === "no_effects") {
      throw error;
    }

    if (plan.route === "needs_review") {
      throw new NonRetriableError(
        needsReviewMessage({
          failedStep: failure.stepName,
          because: plan.because,
        }),
        { cause: error },
      );
    }

    try {
      await runUnwind(step, {
        actions: plan.actions,
        runId,
        attempt,
        deps,
      });
    } catch (compensationError) {
      const compensationFailure = stepFailureOf(compensationError);
      throw new NonRetriableError(
        needsReviewMessage({
          failedStep: failure.stepName,
          because: "compensation_failed",
          ...(compensationFailure.stepName !== undefined
            ? { compensationStep: compensationFailure.stepName }
            : {}),
        }),
        { cause: compensationError },
      );
    }

    throw new NonRetriableError(
      compensatedFailureMessage({
        failedStep: failure.stepName,
        reason: failure.reason ?? "unclassified_error",
        actions: plan.actions,
      }),
      { cause: error },
    );
  }
}

/**
 * Builds the `payment.execute` Inngest function. A thin adapter over
 * `runPaymentExecute` above — deps come in as a plain object rather than
 * being constructed inside this function so tests can pass
 * `FakePayCoreClient`/`InMemoryLedgerRepository` (`./fake-pay-core-client.js`,
 * `../adapters/memory/in-memory-ledger-repository.js`) without any I/O.
 */
export function createPaymentExecuteFunction(deps: PaymentExecuteDeps) {
  const policy = resolveRetryPolicy(deps.retry?.policy);

  return deps.inngest.createFunction(
    {
      id: PAYMENT_EXECUTE_FUNCTION_ID,
      name: "payment.execute",
      retries: inngestRetriesFor(policy),
      triggers: [{ event: paymentExecuteRequested }],
    },
    async ({ event, step, runId, attempt }) =>
      runPaymentExecute(
        step,
        { runId, attempt, eventId: event.id, data: event.data },
        deps,
      ),
  );
}
