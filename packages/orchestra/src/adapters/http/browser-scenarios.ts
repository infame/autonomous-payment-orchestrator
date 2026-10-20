/** Fixed mock fixtures. A visitor chooses an id, never supplies simulation text. */
export const BROWSER_SCENARIOS = [
  {
    id: "clarify-and-pay",
    title: "Resolve an ambiguous invoice",
    summary:
      "The invoice says $1,200 in one place and $1,250 in another. Choose the amount, then approve the payment.",
    effort: "2 decisions · about a minute",
    outcome: "Expected: clarification, approval, then completion.",
    text: "Pay the vendor for the consulting invoice. The invoice header says $1,200.00 but the summary line says $1,250.00. sim.clarify",
  },
  {
    id: "decline-payment",
    title: "Keep the final say",
    summary:
      "A $1,200 invoice is ready for review. Reject the proposal before execution starts.",
    effort: "1 decision · about 20 seconds",
    outcome: "Expected: your rejection stops the payment.",
    text: "Pay the vendor for the consulting invoice. The invoice total is $1,200.00.",
  },
  {
    id: "block-wrong-amount",
    title: "Catch an invented amount",
    summary:
      "The source says $500. The mock proposes $500.01. See the policy layer block the mismatch automatically.",
    effort: "No decisions · about 10 seconds",
    outcome: "Expected: policy rejects the unsupported amount.",
    text: "Pay the vendor for the design retainer. The retainer is $500.00. sim.amount.ungrounded",
  },
] as const;

export const PREPARED_CLARIFICATION =
  "Use the invoice header amount, $1,200.00.";

export function findBrowserScenario(id: string) {
  return BROWSER_SCENARIOS.find((scenario) => scenario.id === id);
}

export function scenarioForText(text: string) {
  return BROWSER_SCENARIOS.find((scenario) => scenario.text === text);
}
