import { z } from "zod";
export const executionEvidenceSchema = z.object({
  payment: z
    .object({
      source: z.literal("pay-core"),
      availability: z.enum(["known", "unknown"]),
      snapshot: z
        .object({
          id: z.string(),
          status: z.string(),
          currency: z.string(),
          amountAuthorized: z.number().int().nonnegative(),
          capturedAmount: z.number().int().nonnegative(),
          refundedAmount: z.number().int().nonnegative(),
        })
        .nullable(),
    })
    .optional(),
  statusSource: z.literal("inngest"),
  run: z.object({
    eventId: z.string(),
    runId: z.string().nullable(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    needsReview: z.boolean(),
  }),
  journal: z.object({
    available: z.boolean(),
    completeness: z.literal("not_guaranteed"),
    attempts: z.array(
      z.object({
        id: z.string(),
        runId: z.string(),
        eventId: z.string().nullable(),
        step: z.enum(["authorize", "capture", "post-ledger"]),
        phase: z.enum(["workflow", "resend"]),
        paymentId: z.string().nullable(),
        operationId: z.string().nullable(),
        idempotencyKey: z.string().nullable(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
        outcome: z.enum(["started", "succeeded", "failed"]),
        errorCode: z.string().nullable(),
      }),
    ),
  }),
  ledger: z.object({
    source: z.literal("ledger"),
    proof: z
      .object({
        paymentId: z.string(),
        currency: z.string(),
        capturedAmount: z.number().int().positive(),
        operationId: z.string().uuid(),
      })
      .nullable(),
    entries: z.array(
      z.object({
        id: z.string(),
        operationId: z.string(),
        account: z.string(),
        direction: z.string(),
        amount: z.object({ amount: z.number().int(), currency: z.string() }),
        paymentId: z.string(),
        entryType: z.string(),
        reversesOperationId: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  resendAvailable: z.boolean(),
});
export const resendResultSchema = z.object({
  capture: z.object({
    id: z.string(),
    status: z.string(),
    currency: z.string(),
    capturedAmount: z.number().int(),
    refundedAmount: z.number().int(),
  }),
  ledgerOutcome: z.enum(["posted", "already_posted"]),
  originalEntryIds: z.array(z.string()),
  returnedEntryIds: z.array(z.string()),
  unchangedEntries: z.boolean(),
  entryCountBefore: z.number().int(),
  entryCountAfter: z.number().int(),
});
