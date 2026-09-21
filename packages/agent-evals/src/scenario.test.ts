import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCorpus, parseScenario, ScenarioLoadError } from "./scenario.js";

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

describe("loadCorpus", () => {
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
