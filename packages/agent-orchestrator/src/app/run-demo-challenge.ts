import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Intent } from "../domain/intent.js";
import { ExecutionInspectionError } from "../domain/errors.js";
import type { IntentRepository } from "../ports/intent-repository.js";
import type { LlmClient } from "../ports/llm-client.js";
import type { ExecutionProfile } from "../ports/execution-credentials.js";
import type { PolicyConfig } from "../policy/rules.js";
import { applyPolicy } from "./apply-policy.js";
import { toIntentView } from "./intent-view.js";
import type { ApproveIntent } from "./approve-intent.js";
import type { AutoApproveIntent } from "./auto-approve-intent.js";

export const DemoChallengeBody = z
  .object({
    scenario: z.enum([
      "duplicates",
      "temporary_failure",
      "inflated_amount",
      "permanent_decline",
    ]),
  })
  .strict();
export type DemoChallenge = z.infer<typeof DemoChallengeBody>["scenario"];
const profiles: Record<DemoChallenge, ExecutionProfile> = {
  duplicates: "demo_ok",
  temporary_failure: "demo_transient",
  inflated_amount: "demo_ok",
  permanent_decline: "demo_decline",
};
/** Fixed simulator challenges: the explicit challenge action authorizes payment. */
export class RunDemoChallenge {
  constructor(
    private readonly repo: IntentRepository,
    private readonly llm: LlmClient,
    private readonly policy: PolicyConfig,
    private readonly approve: Pick<ApproveIntent, "execute">,
    private readonly autoApprove: Pick<AutoApproveIntent, "execute">,
    private readonly enabled: boolean,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async execute(customerId: string, raw: unknown) {
    if (!this.enabled)
      throw new ExecutionInspectionError(404, "not_found", "Not found");
    const { scenario } = DemoChallengeBody.parse(raw);
    const now = this.clock();
    const text =
      `Pay the vendor $${scenario === "permanent_decline" ? "600" : "500"}.00 for the invoice.` +
      (scenario === "inflated_amount" ? " sim.amount.inflated" : "");
    const intent = Intent.submit({ id: randomUUID(), customerId, text, now });
    const proposal = await this.llm.reason({
      intentText: text,
      clarificationAnswer: null,
    });
    if (proposal.kind !== "propose_payment")
      throw new ExecutionInspectionError(
        409,
        "demo_proposal_unavailable",
        "The challenge did not produce a payment proposal",
      );
    intent.propose(proposal, now);
    await applyPolicy(
      intent,
      proposal,
      { repo: this.repo, config: this.policy },
      now,
    );
    await this.repo.create(intent, { executionProfile: profiles[scenario] });
    const view =
      intent.status === "needs_approval"
        ? await this.approve.execute({ intentId: intent.id })
        : intent.status === "proposed"
          ? (
              await this.autoApprove.execute({
                intentId: intent.id,
                customerId,
              })
            ).intent
          : toIntentView(intent);
    return { intent: view, challenge: scenario };
  }
}
