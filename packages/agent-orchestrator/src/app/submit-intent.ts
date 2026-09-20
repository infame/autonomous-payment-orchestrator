import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentProposal } from "../domain/agent-proposal.js";
import {
  CUSTOMER_ID_PATTERN,
  Intent,
  MAX_INTENT_TEXT_LENGTH,
} from "../domain/intent.js";
import { OrchestratorError } from "../domain/errors.js";
import type { PolicyConfig } from "../policy/rules.js";
import { resolvePolicyConfig } from "../policy/rules.js";
import type { PolicyVerdict } from "../policy/verdict.js";
import type { LlmClient } from "../ports/llm-client.js";
import {
  IntentAlreadyExistsError,
  type IntentRepository,
  type StoredIntent,
} from "../ports/intent-repository.js";
import { applyPolicy } from "./apply-policy.js";
import { deriveIntentId } from "./derive-intent-id.js";
import { toIntentView, type IntentView } from "./intent-view.js";

export const SubmitIntentCommand = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_INTENT_TEXT_LENGTH)
    .refine((s) => s.trim().length > 0, { message: "text must not be blank" }),
  customerId: z.string().regex(CUSTOMER_ID_PATTERN),
  /**
   * Optional caller-supplied idempotency key (printable ASCII, no spaces,
   * 1-200 chars — same shape `durable-ledger`'s `IdempotencyKeyHeader`
   * validates, `packages/durable-ledger/src/adapters/http/server-schemas.ts`).
   * When present, `Intent.id` is derived deterministically from
   * `(customerId, idempotencyKey)` instead of randomly generated — see this
   * class's "Idempotent submission" header section.
   */
  idempotencyKey: z
    .string()
    .regex(/^[\x21-\x7E]{1,200}$/)
    .optional(),
});
export type SubmitIntentCommand = z.infer<typeof SubmitIntentCommand>;

export interface SubmitIntentResult {
  readonly intent: IntentView;
  /**
   * `null` only when policy was never reached (a `clarify`/`decline` agent
   * outcome). On `propose_payment` this always carries the verdict,
   * including "allow" — which is deliberately not persisted onto the
   * intent, see this class's header.
   */
  readonly verdict: PolicyVerdict | null;
  /**
   * True iff an earlier call with the same (customerId, idempotencyKey)
   * already created this intent: no LLM call, no policy evaluation, no
   * write happened in THIS call. Always false when no key was supplied.
   */
  readonly replayed: boolean;
}

/**
 * A prior intent exists for this (customerId, idempotencyKey) but with a
 * different `text`. Carries the key (caller-supplied, safe to echo) — NEVER
 * either text.
 */
export class IdempotencyConflictError extends OrchestratorError {
  readonly code = "idempotency_conflict";
  constructor(readonly idempotencyKey: string) {
    super(
      `Idempotency-Key "${idempotencyKey}" was already used to submit an intent with different text`,
    );
  }
}

/**
 * A row already exists at a derived `Intent.id` but belongs to a DIFFERENT
 * `customerId` than the one whose `(customerId, idempotencyKey)` pair just
 * derived that same id. Should be unreachable in practice —
 * `deriveIntentId` (`derive-intent-id.ts`) is a UUIDv5 namespaced on
 * `customerId` itself, so two different customers landing on the same
 * derived id would require an actual SHA-1 collision, not merely an
 * `idempotencyKey` coincidence. This is a genuine SERVER fault, not a
 * caller-fixable 4xx — mapped like `InvalidProposalError`/
 * `IntentAlreadyExistsError` (`server-error-mapper.ts`'s "no generic
 * OrchestratorError fallback" section). Checked explicitly in
 * `#replayOrConflict` so cross-customer safety on the replay path rests on a
 * typed, enforced invariant, not purely on collision-resistance reasoning.
 */
export class IntentDerivationCollisionError extends OrchestratorError {
  readonly code = "intent_derivation_collision";
  constructor(readonly id: string) {
    super(
      `Intent "${id}" exists under a different customerId than the one that just derived this id`,
    );
  }
}

/**
 * Submit a brand-new natural-language intent: create it, ask the `LlmClient`
 * to reason about it once, and — when the agent proposes a payment — run the
 * deterministic policy layer against that proposal.
 *
 * ## Reachable outcomes
 *
 * Exactly four statuses are reachable through this use-case:
 * `needs_clarification` (agent asked a clarifying question), `proposed`
 * (agent proposed a payment and policy allowed it — see `apply-policy.ts`'s
 * header for why an `allow` verdict isn't persisted), `needs_approval`
 * (policy gated the proposal), and `rejected` (agent declined outright, or
 * policy hard-rejected it). `executing` is NOT reachable from this use-case:
 * that requires an `autoApprove`/`approve` call carrying a
 * `durableLedgerEventId` minted by an `AgentCoreClient` call, which is not
 * wired into this slice.
 *
 * The actual policy wiring (querying `countCompletedSince`, building
 * `PolicyContext`, applying the verdict to the intent) lives in
 * `apply-policy.ts`'s `applyPolicy`, shared with `AnswerClarification` — see
 * that file's header for the full rationale, including why an `allow`
 * verdict is never persisted.
 *
 * ## Exactly one repository write
 *
 * This method calls `this.repo.create(intent)` exactly once, at the end,
 * after every domain transition has already happened on the in-memory
 * `intent` instance. It never calls `this.repo.update()` — there is no
 * version to conflict on, since this is a freshly-created aggregate that has
 * not yet been persisted.
 *
 * ## Why it's safe to call the LLM before that write
 *
 * `LlmClient.reason` moves no money and has no durable side effect of its
 * own — unlike the concern `ports/intent-repository.ts`'s header raises for
 * a FUTURE approve-and-execute use-case (which must claim the intent BEFORE
 * calling `durable-ledger`, because a durable-ledger call has to be claimed
 * against exactly once), there is nothing here that a "claim first" pattern
 * would protect. The accepted tradeoff is the mirror image: if the LLM call
 * fails, this method leaves no persisted row at all. That's fine — there's
 * no orphan `received` row left behind, and nothing in this or the next
 * slice could resume a half-submitted intent anyway.
 *
 * ## Idempotent submission
 *
 * When the caller supplies `idempotencyKey`, `Intent.id` is
 * `deriveIntentId(customerId, idempotencyKey)` (deterministic) instead of
 * `newId()` (random) — see `derive-intent-id.ts`. This is checked in TWO
 * disjoint places, both necessary, neither alone sufficient:
 *
 *   1. A pre-check (`this.repo.findById(id)` before attempting anything
 *      else) — a cost optimization for the ordinary sequential retry case
 *      (client timeout retry, double-click): it saves an LLM call on the
 *      common path by returning the earlier result directly.
 *   2. A catch around `this.repo.create()` for `IntentAlreadyExistsError` —
 *      handles the case where TWO concurrent requests with the same key
 *      both pass the pre-check (both see nothing, because neither has
 *      written yet) and race to `create()`. The winner's write succeeds;
 *      the loser's `create()` throws `IntentAlreadyExistsError`, which is
 *      caught and turned into the SAME replay result the winner got,
 *      instead of propagating as a server error to the caller.
 *
 * In both places, "replay" means: if the existing intent's `customerId` AND
 * `text` both match the command's, return it with `replayed: true` and do
 * nothing else (no LLM call, no policy evaluation, no write). If `text`
 * differs, throw `IdempotencyConflictError` instead — a genuine key-reuse
 * conflict, never a silent replay of stale content. If `customerId` differs
 * (which `deriveIntentId`'s UUIDv5 namespacing on `customerId` makes an
 * actual hash collision, not just an ordinary key reuse — see
 * `IntentDerivationCollisionError`'s own header), throw that instead: a
 * checked, typed invariant rather than resting purely on collision
 * resistance.
 *
 * On the UNKEYED path (no `idempotencyKey` supplied), behavior is
 * byte-identical to before this feature existed: `newId()` mints a random
 * id, `replayed` is always `false`, and `IntentAlreadyExistsError` still
 * escapes uncaught — a `newId()` collision without a key is a genuine
 * server fault (near-impossible with `randomUUID()`), not something to
 * paper over with a replay.
 */
export class SubmitIntent {
  private readonly policyConfig: PolicyConfig;

  constructor(
    private readonly repo: IntentRepository,
    private readonly llm: LlmClient,
    policyConfig: Partial<PolicyConfig> = {},
    private readonly clock: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID(),
  ) {
    // Fail fast on a bad config at construction time, not on the first request.
    this.policyConfig = resolvePolicyConfig(policyConfig);
  }

  async execute(raw: SubmitIntentCommand): Promise<SubmitIntentResult> {
    const command = SubmitIntentCommand.parse(raw);
    const now = this.clock();

    const { idempotencyKey } = command;
    if (idempotencyKey !== undefined) {
      const id = deriveIntentId(command.customerId, idempotencyKey);
      const existing = await this.repo.findById(id);
      if (existing) {
        return this.#replayOrConflict(
          existing,
          command.customerId,
          command.text,
          idempotencyKey,
        );
      }

      const intent = Intent.submit({
        id,
        customerId: command.customerId,
        text: command.text,
        now,
      });
      try {
        return await this.#reasonAndPersist(intent, now);
      } catch (err) {
        if (err instanceof IntentAlreadyExistsError) {
          // Two concurrent same-key requests both passed the pre-check
          // above and raced to create() — replay the winner's row instead
          // of surfacing this as a server error. See class header.
          const raced = await this.repo.findById(id);
          if (raced) {
            return this.#replayOrConflict(
              raced,
              command.customerId,
              command.text,
              idempotencyKey,
            );
          }
          // Should never happen: nothing deletes intents. Defensive rethrow.
          throw err;
        }
        throw err;
      }
    }

    const intent = Intent.submit({
      id: this.newId(),
      customerId: command.customerId,
      text: command.text,
      now,
    });
    return this.#reasonAndPersist(intent, now);
  }

  /**
   * Returns a `replayed: true` result if `customerId` and `text` both match,
   * else throws `IntentDerivationCollisionError` (customerId mismatch — see
   * that class's header, should be unreachable) or `IdempotencyConflictError`
   * (text mismatch). Never re-runs the LLM/policy/writes.
   */
  #replayOrConflict(
    existing: StoredIntent,
    customerId: string,
    text: string,
    idempotencyKey: string,
  ): SubmitIntentResult {
    if (existing.intent.customerId !== customerId) {
      // Should be unreachable — see IntentDerivationCollisionError's header.
      // Checked explicitly anyway so this invariant is enforced by code, not
      // only by deriveIntentId's collision-resistance.
      throw new IntentDerivationCollisionError(existing.intent.id);
    }
    if (existing.intent.text !== text) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return {
      intent: toIntentView(existing.intent),
      verdict: null,
      replayed: true,
    };
  }

  /** The non-replay path: LLM reasoning → (optionally) policy → exactly one `create()`. */
  async #reasonAndPersist(
    intent: Intent,
    now: Date,
  ): Promise<SubmitIntentResult> {
    const proposal = await this.llm.reason({
      intentText: intent.text,
      clarificationAnswer: null,
    });

    let verdict: PolicyVerdict | null = null;
    switch (proposal.kind) {
      case "clarify":
        intent.clarify(proposal, now);
        break;
      case "decline":
        intent.declineByAgent(proposal, now);
        break;
      case "propose_payment": {
        intent.propose(proposal, now);
        verdict = await applyPolicy(
          intent,
          proposal,
          { repo: this.repo, config: this.policyConfig },
          now,
        );
        break;
      }
      default: {
        const exhaustive: never = proposal;
        // Never stringify the full proposal here — it may carry LLM-authored
        // free text (reasoning/question/reason) derived from customer input.
        // Only the structural discriminator is safe to put in an error message.
        throw new Error(
          `Unhandled AgentProposal kind: ${String((exhaustive as AgentProposal).kind)}`,
        );
      }
    }

    const stored = await this.repo.create(intent);
    return { intent: toIntentView(stored.intent), verdict, replayed: false };
  }
}
