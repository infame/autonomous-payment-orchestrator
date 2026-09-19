import { z } from "zod";
import { SubmitIntentCommand } from "../../app/submit-intent.js";
import { AnswerClarificationCommand } from "../../app/answer-clarification.js";

/**
 * `agent.intents.id` is a real Postgres `uuid` column, and
 * `adapters/persistence/drizzle/errors.ts` classifies ONLY SQLSTATE 23505 —
 * so an unvalidated non-UUID `:id` reaches the driver and comes back as a
 * raw 22P02, mapped to a generic 500 instead of a clean 404.
 * `InMemoryIntentRepository` returns `null` for the same input, so no
 * in-memory test can ever catch a missing guard here. Deliberately NARROWER
 * than the use-case commands' own `intentId: z.string().min(1)` — do not
 * "align" them by widening this or narrowing those; the commands must stay
 * id-format-agnostic for the in-memory adapter and existing fixtures.
 */
export const IntentIdParam = z.string().uuid();

/**
 * The SOLE caller-identity channel (ADR-0014). Deliberately the very same
 * schema object `SubmitIntentCommand` validates `customerId` with — not a
 * re-declared `z.string().regex(CUSTOMER_ID_PATTERN)` — so header validation
 * at the boundary can never drift from what the use-case itself accepts.
 */
export const CustomerIdHeader = SubmitIntentCommand.shape.customerId;

/**
 * `customerId` is REMOVED from the body: identity comes from `X-Customer-Id`
 * and nowhere else (ADR-0014). Spec §7's `merchantId?` is dropped, not
 * omitted-for-now — see the README. Unknown keys stay stripped (Zod
 * default), never `.strict()`, matching pay-core's `schemas.ts`.
 */
export const SubmitIntentBody = SubmitIntentCommand.omit({ customerId: true });
export type SubmitIntentBody = z.infer<typeof SubmitIntentBody>;

export const AnswerClarificationBody = AnswerClarificationCommand.omit({
  intentId: true,
});
export type AnswerClarificationBody = z.infer<typeof AnswerClarificationBody>;

// approve / reject / GET have no body fields — nothing to declare.
