import type { AgentProposal } from "../../domain/agent-proposal.js";
import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
} from "../../domain/agent-proposal.js";
import { extractGroundedAmounts } from "../../policy/grounding.js";
import type { LlmClient, LlmReasoningRequest } from "../../ports/llm-client.js";
import { LlmUnavailableError } from "../../ports/llm-client.js";
import type {
  AmountSelector,
  MockOutcome,
  ParsedDirectives,
} from "./directives.js";
import { mergeDirectives, parseDirectives } from "./directives.js";

/**
 * `MockLlmClient` — the deterministic, directive-driven `LlmClient`
 * implementation. It stands in for `AnthropicLlmClient`
 * (`adapters/llm/anthropic-llm-client.ts`, step 7) everywhere a real model
 * call would otherwise be needed: local development, tests, and the public
 * demo's `mock` mode (spec §5). `AnthropicLlmClient` exists as a standalone
 * adapter as of step 7, and `config.ts`'s `LLM_MODE` switch (step 8) now
 * exists too, but nothing wires it up yet — no composition root reads it —
 * so this class remains the only `LlmClient` actually reachable anywhere in
 * this codebase today.
 *
 * ## Why the directive grammar is digit-free
 *
 * `sim.amount.min` / `sim.amount.max` / `sim.amount.ungrounded`
 * (`directives.ts`) never carry a literal amount. That's a deliberate
 * constraint, not a limitation of the grammar: unlike `pay-core`'s
 * `paymentMethodToken`, which is an OPAQUE carrier the simulator is free to
 * stuff an outcome into because nothing else ever reads it as real data,
 * `intentText` here is genuinely parsed — `extractGroundedAmounts` (reused
 * directly below) and the policy layer's `amountMustBeGrounded` rule both
 * treat it as the one source of truth for which amounts are "real". A
 * grammar that let a directive smuggle in `sim.amount.15000` would let the
 * mock propose amounts that don't actually appear in the text, silently
 * defeating the exact guardrail this whole package exists to exercise. The
 * grammar instead only ever SELECTS among amounts `extractGroundedAmounts`
 * already finds.
 *
 * One direct consequence: a test that asserts `sim.amount.min`/`.max`
 * produce an `allow` verdict from `evaluatePolicy` is NOT independently
 * proving `amountMustBeGrounded` — the selected amount is grounded by
 * construction, so that would be tautological. `policy/rules.test.ts` is
 * where the grounding rule itself is proven; the mock's own tests only need
 * to prove correct wiring. `sim.amount.ungrounded` is the exception: it
 * deliberately proposes an amount ONE MORE than the largest candidate found
 * (or `UNGROUNDED_FALLBACK_AMOUNT` when there are no candidates at all), the
 * one directive here that produces a genuinely adversarial, non-tautological
 * case worth asserting a `reject` against.
 *
 * ## `sim.clarify` only fires on the first pass
 *
 * `Intent`'s own state machine (`domain/intent.ts`) has no
 * `needs_clarification → needs_clarification` edge — a second clarification
 * round has no legal destination. This class mirrors that at the LLM-call
 * boundary: a `clarify` outcome is only honoured when
 * `input.clarificationAnswer === null` (the first call for this intent). If
 * a `clarify` directive is still in effect on a second call (`
 * clarificationAnswer !== null`), it's resolved to something the domain CAN
 * accept instead of being returned as-is — see `#resolveClarifyFallthrough`.
 *
 * ## Stateless and deterministic
 *
 * Unlike `SimulatorProvider`'s counter-based `fail_then_succeed` (which
 * needs a live consumer to retry the SAME operation multiple times before
 * flipping outcome), this package makes exactly one `LlmClient.reason` call
 * per intent per round, with no retry loop above it. There is nothing to
 * count. `reason()` is a pure function of its two inputs plus this
 * instance's fixed config: identical `(intentText, clarificationAnswer)`
 * always produces a deep-equal `AgentProposal`, and no call mutates
 * anything on the instance.
 */

export interface MockLlmConfig {
  readonly defaultOutcome?: MockOutcome;
  readonly defaultCurrency?: string;
  readonly defaultMerchantId?: string;
}

const DEFAULT_OUTCOME: MockOutcome = { kind: "payment", selector: "min" };
const DEFAULT_CURRENCY = "USD";
const DEFAULT_MERCHANT_ID = "demo_merchant";
/**
 * A safe-integer minor-units amount used only when `sim.amount.ungrounded`
 * fires against text with zero candidate amounts (nothing to add 1 to).
 */
const UNGROUNDED_FALLBACK_AMOUNT = 133_700;

const EMPTY_DIRECTIVES: ParsedDirectives = {
  outcome: null,
  currency: null,
  merchantId: null,
};

export class MockLlmClient implements LlmClient {
  readonly name = "mock";
  readonly #config: Required<MockLlmConfig>;

  constructor(config?: MockLlmConfig) {
    this.#config = {
      defaultOutcome: config?.defaultOutcome ?? DEFAULT_OUTCOME,
      defaultCurrency: config?.defaultCurrency ?? DEFAULT_CURRENCY,
      defaultMerchantId: config?.defaultMerchantId ?? DEFAULT_MERCHANT_ID,
    };
  }

  async reason(input: LlmReasoningRequest): Promise<AgentProposal> {
    const textDirectives = parseDirectives(input.intentText);
    const answerDirectives =
      input.clarificationAnswer !== null
        ? parseDirectives(input.clarificationAnswer)
        : EMPTY_DIRECTIVES;
    const merged = mergeDirectives(answerDirectives, textDirectives);

    let outcome: MockOutcome = merged.outcome ?? this.#config.defaultOutcome;

    if (outcome.kind === "clarify" && input.clarificationAnswer !== null) {
      const fallbackSelector = this.#resolveClarifyFallthrough();
      if (fallbackSelector === null) {
        return declineProposal(
          "Clarification was already requested once; a second clarification round is not possible",
        );
      }
      outcome = { kind: "payment", selector: fallbackSelector };
    }

    if (outcome.kind === "unavailable") {
      throw new LlmUnavailableError("simulated outage");
    }
    if (outcome.kind === "decline") {
      return declineProposal(`Simulated decline: ${outcome.slug}`);
    }
    if (outcome.kind === "clarify") {
      // Only reachable here when clarificationAnswer === null — see header.
      return clarifyProposal(`Simulated clarification: ${outcome.slug}`);
    }

    return this.#buildPaymentProposal(input, outcome.selector, merged);
  }

  /**
   * The domain has no legal second `clarify`, so on a second call this
   * resolves to SOME concrete, non-clarify outcome instead: the configured
   * default's amount selector when that default is itself a payment
   * proposal (honouring the caller's configured preference), or a graceful
   * decline when the default is itself `clarify`/`decline`/`unavailable` —
   * none of which is a legal second answer either, so compounding one
   * unresolvable outcome into another would just move the problem, not
   * solve it.
   */
  #resolveClarifyFallthrough(): AmountSelector | null {
    const fallback = this.#config.defaultOutcome;
    return fallback.kind === "payment" ? fallback.selector : null;
  }

  #buildPaymentProposal(
    input: LlmReasoningRequest,
    selector: AmountSelector,
    merged: ParsedDirectives,
  ): AgentProposal {
    const candidates = new Set([
      ...extractGroundedAmounts(input.intentText),
      ...(input.clarificationAnswer !== null
        ? extractGroundedAmounts(input.clarificationAnswer)
        : []),
    ]);

    let amount: number;
    if (selector === "ungrounded") {
      amount =
        candidates.size === 0
          ? UNGROUNDED_FALLBACK_AMOUNT
          : Math.max(...candidates) + 1;
    } else if (candidates.size === 0) {
      return declineProposal("No amount found in the intent text");
    } else {
      amount =
        selector === "max" ? Math.max(...candidates) : Math.min(...candidates);
    }

    return paymentProposal({
      amount,
      currency: merged.currency ?? this.#config.defaultCurrency,
      merchantId: merged.merchantId ?? this.#config.defaultMerchantId,
      reasoning:
        selector === "ungrounded"
          ? "Verified against the invoice; this is the correct amount."
          : `Selected the ${selector} candidate amount found in the intent text, per the safe-interpretation rule.`,
    });
  }
}
