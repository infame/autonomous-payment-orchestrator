import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reportOf } from "./test-support.js";
import { findBaseline, readBaseline, writeReport } from "./write.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "evals-write-"));

describe("writeReport", () => {
  it("writes both files with the UTC ms timestamp filename and creates the dir", async () => {
    const out = join(tmp(), "nested", "reports");
    const r = await reportOf("clean");
    const written = writeReport(
      r,
      "# md",
      out,
      new Date("2026-03-04T05:06:07.008Z"),
    );
    expect(written.jsonPath).toBe(
      join(out, "20260304T050607008Z-hostile.json"),
    );
    expect(written.mdPath).toBe(join(out, "20260304T050607008Z-hostile.md"));
    expect(JSON.parse(readFileSync(written.jsonPath, "utf8"))).toEqual(r);
    expect(readFileSync(written.mdPath, "utf8")).toBe("# md\n");
  });
});

describe("findBaseline", () => {
  it("returns the newest hostile json, ignoring other modes and non-json", () => {
    const dir = tmp();
    for (const f of [
      "20260101T000000000Z-hostile.json",
      "20260303T000000000Z-hostile.json",
      "20260505T000000000Z-live.json",
      "20260404T000000000Z-hostile.md",
      "notes.json",
    ]) {
      writeFileSync(join(dir, f), "{}");
    }
    expect(findBaseline(dir, "hostile")).toBe(
      join(dir, "20260303T000000000Z-hostile.json"),
    );
  });

  it("returns null for an unknown mode, never treating it as a pattern", () => {
    const dir = tmp();
    writeFileSync(join(dir, "20260101T000000000Z-hostile.json"), "{}");
    writeFileSync(join(dir, "20260101T000000000Z-live.json"), "{}");
    for (const mode of [".*", "hostile|live", "constructor", ""]) {
      expect(findBaseline(dir, mode as "hostile"), mode).toBeNull();
    }
  });

  it("returns null for an empty or missing directory", () => {
    const dir = tmp();
    expect(findBaseline(dir, "hostile")).toBeNull();
    expect(findBaseline(join(dir, "nope"), "hostile")).toBeNull();
    mkdirSync(join(dir, "sub"));
    expect(findBaseline(join(dir, "sub"), "hostile")).toBeNull();
  });
});

describe("readBaseline", () => {
  it("round-trips a written report", async () => {
    const r = await reportOf("violating");
    const { jsonPath } = writeReport(r, "x", tmp(), new Date(0));
    expect(readBaseline(jsonPath)).toEqual(r);
  });

  it("returns null for missing, invalid or version-mismatched files", async () => {
    const dir = tmp();
    expect(readBaseline(join(dir, "missing.json"))).toBeNull();
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(readBaseline(join(dir, "bad.json"))).toBeNull();
    const r = await reportOf("clean");
    writeFileSync(
      join(dir, "v99.json"),
      JSON.stringify({ ...r, schemaVersion: 99 }),
    );
    expect(readBaseline(join(dir, "v99.json"))).toBeNull();
    writeFileSync(
      join(dir, "shape.json"),
      JSON.stringify({ schemaVersion: 1 }),
    );
    expect(readBaseline(join(dir, "shape.json"))).toBeNull();
  });
});
