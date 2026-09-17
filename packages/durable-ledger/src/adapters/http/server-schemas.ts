import { z } from "zod";
import { paymentExecuteRequestedSchema } from "../../workflow/events.js";

/** Re-exported, not redeclared — the trigger route's body must never drift from the event schema the workflow itself validates against. */
export const StartPaymentWorkflowBody = paymentExecuteRequestedSchema;
export type StartPaymentWorkflowBody = z.infer<typeof StartPaymentWorkflowBody>;

/** Inngest event ids are ULIDs — 26 Crockford-base32 characters. */
export const EventIdParam = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, "Invalid event id");

export const LedgerEntriesQuery = z
  .object({
    paymentId: z.string().min(1).optional(),
    operationId: z.string().uuid().optional(),
  })
  .refine(
    (q) => (q.paymentId === undefined) !== (q.operationId === undefined),
    {
      message: "Provide exactly one of paymentId or operationId",
    },
  );
export type LedgerEntriesQuery = z.infer<typeof LedgerEntriesQuery>;

export const CurrencyQuery = z
  .string()
  .regex(/^[A-Z]{3}$/, "Invalid ISO-4217 currency");

/**
 * Optional caller-supplied de-duplication key for `POST /workflows/payment`.
 * Printable ASCII, no spaces/control characters: the value is handed to
 * Inngest as an event `id` and shows up verbatim in its dashboard and in
 * `GET /v1/events`. NOT `EventIdParam`'s ULID rule — that constraint is
 * Inngest's, on *its own* server-assigned ids (`GET /v1/events/:id/runs`
 * answers `400 Invalid event ID` for a non-ULID), and does not apply to a
 * client-supplied dedupe id, which Inngest accepts as an arbitrary string.
 * 200 chars is our own bound, not Inngest's (which accepted 600+ in manual
 * testing) — kept conservative for dashboard/log readability.
 */
export const IdempotencyKeyHeader = z
  .string()
  .regex(/^[\x21-\x7E]{1,200}$/, "Invalid Idempotency-Key");
