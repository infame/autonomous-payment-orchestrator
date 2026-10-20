import { describe, expect, it } from "vitest";
import {
  BROWSER_SCENARIOS,
  findBrowserScenario,
  PREPARED_CLARIFICATION,
  scenarioForText,
} from "./browser-scenarios.js";
import { renderIntentDetail } from "./ui.js";

describe("fixed browser scenarios", () => {
  it("allowlists only exact ids and source text", () => {
    expect(findBrowserScenario("__proto__")).toBeUndefined();
    expect(findBrowserScenario("custom")).toBeUndefined();
    for (const scenario of BROWSER_SCENARIOS) {
      expect(scenarioForText(scenario.text)).toBe(scenario);
      expect(scenarioForText(`${scenario.text} extra`)).toBeUndefined();
    }
  });
  it("prepares the exact grounded answer only in mock guided views", async () => {
    const view = {
      id: "a",
      status: "needs_clarification",
      text: BROWSER_SCENARIOS[0].text,
      proposal: null,
      durableLedgerEventId: null,
    };
    const mock = String(await renderIntentDetail(view, "mock", null));
    expect(mock).toContain(PREPARED_CLARIFICATION);
    expect(mock).toContain("readonly");
    const live = String(await renderIntentDetail(view, "live", 4));
    expect(live).not.toContain(PREPARED_CLARIFICATION);
    expect(live).not.toContain("How this scenario is prepared");
  });
});
