import { describe, expect, it } from "vitest";
import { checkExpectations } from "./expectations.js";
import {
  exchange,
  observation,
  observedIntent,
  startCall,
  view,
} from "./oracles/observation-fixture.js";
import type { InvariantResult } from "./oracles/index.js";
import { parseScenario } from "./scenario.js";
import type { Scenario } from "./scenario.js";

function scenario(expectOverrides: Record<string, unknown> = {}): Scenario {
  return parseScenario(
    "f.json",
    JSON.stringify({
      id: "unit-01",
      category: "benign",
      description: "d",
      customerId: "cust_unit",
      text: "t",
      llm: { mode: "mock" },
      expect: {
        terminal: ["executing"],
        coreCalls: { min: 1, max: 1 },
        ...expectOverrides,
      },
    }),
  );
}

const linked = [exchange({ coreCallIndexes: [0] })];
const good = () => observation({ coreCalls: [startCall()], http: linked });
const results = (subjects: number): InvariantResult[] => [
  { id: "I1", title: "t", subjects, violations: [] },
];

describe("checkExpectations", () => {
  it("returns [] for a fully satisfied observation", () => {
    const s = scenario({ startAmounts: [12000], nonVacuous: ["I1"] });
    expect(checkExpectations(s, good(), results(1))).toEqual([]);
  });

  it("no_intents", () => {
    const f = checkExpectations(
      scenario(),
      observation({ intents: [], coreCalls: [startCall()] }),
      results(1),
    );
    expect(f.map((x) => x.kind)).toContain("no_intents");
  });

  it("terminal (wrong status and missing view)", () => {
    const wrong = checkExpectations(
      scenario({ terminal: ["completed"] }),
      good(),
      results(1),
    );
    expect(wrong.map((x) => x.kind)).toEqual(["terminal"]);
    const missing = checkExpectations(
      scenario(),
      observation({
        intents: [observedIntent({ finalView: null })],
        coreCalls: [startCall()],
        http: linked,
      }),
      results(1),
    );
    expect(missing.map((x) => x.kind)).toEqual(["terminal"]);
  });

  it("core_calls", () => {
    const f = checkExpectations(
      scenario({ coreCalls: { min: 0, max: 0 } }),
      good(),
      results(1),
    );
    expect(f.map((x) => x.kind)).toEqual(["core_calls"]);
  });

  it("rejection_reason never leaks the verdict detail", () => {
    const obs = observation({
      intents: [
        observedIntent({
          finalView: view({
            status: "rejected",
            policyVerdict: {
              decision: "reject",
              reason: "hard_limit_exceeded",
              detail: "SECRET-DETAIL",
            },
          }),
        }),
      ],
    });
    const f = checkExpectations(
      scenario({
        terminal: ["rejected"],
        coreCalls: { min: 0, max: 0 },
        rejectionReason: "amount_not_grounded",
      }),
      obs,
      results(1),
    );
    expect(f.map((x) => x.kind)).toEqual(["rejection_reason"]);
    expect(f[0]?.message).toContain("hard_limit_exceeded");
    expect(f[0]?.message).not.toContain("SECRET-DETAIL");
  });

  it("start_amounts", () => {
    const f = checkExpectations(
      scenario({ startAmounts: [8000] }),
      good(),
      results(1),
    );
    expect(f.map((x) => x.kind)).toEqual(["start_amounts"]);
  });

  it("vacuous_invariant", () => {
    const f = checkExpectations(
      scenario({ nonVacuous: ["I1", "I5"] }),
      good(),
      results(0),
    );
    expect(f.map((x) => x.kind)).toEqual([
      "vacuous_invariant",
      "vacuous_invariant",
    ]);
  });
});
