/**
 * Line-by-line-explainable floor (README, "Considered and rejected", fast-check
 * entry): every non-test `.ts` file under `src/` must start with a `/**` file
 * header on line 1. `.test.ts` files are excluded — they are self-describing
 * via their own `describe`/`it` names, and a header requirement there would
 * just be restating the test titles. This is a FLOOR, not a rewrite: it
 * checks for a file-level header's presence only, never per-symbol JSDoc.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

function listSourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true })
    .filter((f): f is string => typeof f === "string")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

describe("doc headers", () => {
  it.each(listSourceFiles())("%s starts with a /** file header", (file) => {
    const content = readFileSync(join(SRC_DIR, file), "utf8");
    expect(content.startsWith("/**")).toBe(true);
  });
});
