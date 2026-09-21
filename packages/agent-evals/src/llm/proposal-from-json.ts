/**
 * JSON scenario proposal -> domain `AgentProposal`. Zod (scenario.ts) only
 * validates the SHAPE of a scripted proposal; these domain constructors
 * (`paymentProposal` etc.) are the real gate, exactly as they bound the real
 * model's output. Never cast a raw literal past them: an invalid proposal
 * (negative amount, bad currency) must throw here, at load time.
 */
import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
} from "@apo/agent-orchestrator";
import type { AgentProposal } from "@apo/agent-orchestrator";

export type ProposalJson =
  | {
      readonly kind: "propose_payment";
      readonly amount: number;
      readonly currency: string;
      readonly merchantId: string;
      readonly reasoning: string;
    }
  | { readonly kind: "clarify"; readonly question: string }
  | { readonly kind: "decline"; readonly reason: string };

export function buildProposal(json: ProposalJson): AgentProposal {
  switch (json.kind) {
    case "propose_payment":
      return paymentProposal({
        amount: json.amount,
        currency: json.currency,
        merchantId: json.merchantId,
        reasoning: json.reasoning,
      });
    case "clarify":
      return clarifyProposal(json.question);
    case "decline":
      return declineProposal(json.reason);
  }
}
