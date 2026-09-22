import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCorpus,
  parseScenario,
  parseScenarioValue,
  ScenarioLoadError,
} from "./scenario.js";

function valid(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "unit-01",
    category: "benign",
    description: "unit fixture",
    customerId: "cust_unit",
    text: "Pay $120 to acme for invoice 42",
    llm: {
      mode: "script",
      proposals: [
        {
          kind: "propose_payment",
          amount: 12000,
          currency: "USD",
          merchantId: "acme",
          reasoning: "r",
        },
      ],
    },
    expect: { terminal: ["proposed"], coreCalls: { min: 0, max: 0 } },
    ...overrides,
  };
}

const dirs: string[] = [];
function tempDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-corpus-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseScenario", () => {
  it("accepts a valid scenario", () => {
    expect(parseScenario("f.json", JSON.stringify(valid())).id).toBe("unit-01");
  });

  it("throws a ScenarioLoadError naming the file on malformed JSON", () => {
    expect(() => parseScenario("/x/broken.json", "{nope")).toThrow(
      /\/x\/broken\.json/,
    );
    expect(() => parseScenario("/x/broken.json", "{nope")).toThrow(
      ScenarioLoadError,
    );
  });

  it("names the scenario id on an unknown category", () => {
    expect(() =>
      parseScenario("f.json", JSON.stringify(valid({ category: "nope" }))),
    ).toThrow(/unit-01/);
  });

  it("rejects an unknown key (.strict())", () => {
    expect(() =>
      parseScenario("f.json", JSON.stringify(valid({ extra: 1 }))),
    ).toThrow(ScenarioLoadError);
  });

  it("rejects coreCalls with min > max", () => {
    expect(() =>
      parseScenario(
        "f.json",
        JSON.stringify(
          valid({
            expect: { terminal: ["proposed"], coreCalls: { min: 2, max: 1 } },
          }),
        ),
      ),
    ).toThrow(ScenarioLoadError);
  });

  it("does not accept live mode", () => {
    expect(() =>
      parseScenario("f.json", JSON.stringify(valid({ llm: { mode: "live" } }))),
    ).toThrow(ScenarioLoadError);
  });

  it("fails at LOAD, naming the id, for a scripted proposal the domain rejects", () => {
    const bad = valid({
      llm: {
        mode: "script",
        proposals: [
          {
            kind: "propose_payment",
            amount: -1,
            currency: "USD",
            merchantId: "acme",
            reasoning: "r",
          },
        ],
      },
    });
    expect(() => parseScenario("f.json", JSON.stringify(bad))).toThrow(
      /unit-01.*amount/,
    );
  });
});

describe("parseScenarioValue", () => {
  it("accepts a decoded value and runs the domain-constructor gate", () => {
    expect(parseScenarioValue("mem", valid()).id).toBe("unit-01");
    const bad = valid({
      llm: {
        mode: "script",
        proposals: [
          {
            kind: "propose_payment",
            amount: 1.5,
            currency: "USD",
            merchantId: "acme",
            reasoning: "r",
          },
        ],
      },
    });
    expect(() => parseScenarioValue("mem", bad)).toThrow(
      /mem \(scenario "unit-01"\).*amount/,
    );
    expect(() => parseScenarioValue("mem", { id: 3 })).toThrow(
      ScenarioLoadError,
    );
  });

  it("accepts category fuzz (only the corpus loader bans it)", () => {
    expect(
      parseScenarioValue("mem", valid({ category: "fuzz" })).category,
    ).toBe("fuzz");
  });
});

describe("loadCorpus", () => {
  it("rejects a corpus file whose category is fuzz", () => {
    const dir = tempDir({ "unit-01.json": valid({ category: "fuzz" }) });
    expect(() => loadCorpus(dir)).toThrow(/reserved for generated/);
  });

  it("throws when the filename does not match the id", () => {
    const dir = tempDir({ "other-name.json": valid() });
    expect(() => loadCorpus(dir)).toThrow(/other-name\.json.*unit-01/);
  });

  it("rejects a second file carrying an already-used id (via the filename rule)", () => {
    const dir = tempDir({
      "unit-01.json": valid(),
      "unit-01.copy.json": valid(),
    });
    expect(() => loadCorpus(dir)).toThrow(/unit-01\.copy\.json/);
  });

  it("loads only .json files, sorted by filename", () => {
    const dir = tempDir({
      "b-01.json": valid({ id: "b-01" }),
      "a-01.json": valid({ id: "a-01" }),
    });
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(loadCorpus(dir).map((s) => s.id)).toEqual(["a-01", "b-01"]);
  });
});

describe("loader hardening", () => {
  it("wraps a missing corpus directory in a ScenarioLoadError", () => {
    expect(() => loadCorpus(join(tmpdir(), "definitely-missing-xyz"))).toThrow(
      ScenarioLoadError,
    );
  });

  it("rejects a step `as` that is not a valid customer id and accepts a valid one", () => {
    const step = (as: string) => ({ kind: "get", as });
    expect(() =>
      parseScenario(
        "f.json",
        JSON.stringify(valid({ steps: [step("bad id!")] })),
      ),
    ).toThrow(ScenarioLoadError);
    expect(
      parseScenario(
        "f.json",
        JSON.stringify(valid({ steps: [step("cust_attacker_9")] })),
      ).id,
    ).toBe("unit-01");
  });

  it("rejects a submit step idempotencyKey outside the header-safe charset", () => {
    expect(() =>
      parseScenario(
        "f.json",
        JSON.stringify(
          valid({ steps: [{ kind: "submit", idempotencyKey: "has space" }] }),
        ),
      ),
    ).toThrow(ScenarioLoadError);
  });

  it("requires rejectionReason alongside rejectionReasonIntent, in range of intents.max", () => {
    const expectWith = (extra: Record<string, unknown>) =>
      JSON.stringify(
        valid({
          expect: {
            terminal: ["rejected"],
            coreCalls: { min: 0, max: 0 },
            ...extra,
          },
        }),
      );
    expect(() =>
      parseScenario("f.json", expectWith({ rejectionReasonIntent: 0 })),
    ).toThrow(ScenarioLoadError);
    expect(() =>
      parseScenario(
        "f.json",
        expectWith({
          rejectionReason: "hard_limit_exceeded",
          rejectionReasonIntent: 2,
          intents: { min: 1, max: 2 },
        }),
      ),
    ).toThrow(ScenarioLoadError);
    expect(
      parseScenario(
        "f.json",
        expectWith({
          rejectionReason: "hard_limit_exceeded",
          rejectionReasonIntent: 1,
          intents: { min: 1, max: 2 },
        }),
      ).id,
    ).toBe("unit-01");
  });
});
