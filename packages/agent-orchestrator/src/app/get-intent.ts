import { IntentNotFoundError } from "../domain/errors.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import { toIntentView, type IntentView } from "./intent-view.js";

/**
 * Read an intent's current state. A pure query — no mutation, no LLM call,
 * no policy re-evaluation.
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
