import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fixtureDir } from "./report/test-support.js";

const run = promisify(execFile);
const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const tsxBin = join(pkgDir, "node_modules/.bin/tsx");

async function spawnMain(
  corpus: string,
): Promise<{ status: number; out: string }> {
  const out = mkdtempSync(join(tmpdir(), "evals-main-"));
  let status = 0;
  try {
    await run(tsxBin, ["src/cli-main.ts", "--corpus", corpus, "--out", out], {
      cwd: pkgDir,
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    status = typeof code === "number" ? code : -1;
  }
  return { status, out };
}

describe("cli-main entry", () => {
  it("exits 1 with a report on disk for a violating corpus", async () => {
    const { status, out } = await spawnMain(fixtureDir("violating"));
    expect(status).toBe(1);
    expect(readdirSync(out).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  }, 30_000);

  it("exits 0 for a clean corpus", async () => {
    const { status, out } = await spawnMain(fixtureDir("clean"));
    expect(status).toBe(0);
    expect(readdirSync(out).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  }, 30_000);
});
