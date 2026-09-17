import { IntentNotFoundError } from "../domain/errors.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import { toIntentView, type IntentView } from "./intent-view.js";

/**
 * Read an intent's current state. A pure query — no mutation, no LLM call,
 * no policy re-evaluation.
 *
 * ## No caller/customer scoping (yet)
 *
 * `execute` takes a bare `intentId` — no caller identity, no check that the
 * requester owns this intent. Ownership scoping against `Intent.customerId`
 * is deferred to the future HTTP/auth layer (step 8) and MUST be enforced
 * there before this is exposed as `GET /intents/:id` — this use-case alone
 * cannot and does not check it.
 */
export class GetIntent {
  constructor(private readonly repo: IntentRepository) {}

  async execute(intentId: string): Promise<IntentView> {
    const stored = await this.repo.findById(intentId);
    if (!stored) {
      throw new IntentNotFoundError(intentId);
    }
    return toIntentView(stored.intent);
  }
}
