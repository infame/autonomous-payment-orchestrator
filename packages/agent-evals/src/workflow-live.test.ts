import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  fileURLToPath(
    new URL("../../../.github/workflows/evals-live.yml", import.meta.url),
  ),
  "utf8",
);
const evalStep = workflow
  .split("      - name: eval:live\n")[1]
  ?.split("      - uses: actions/upload-artifact")[0];
if (evalStep === undefined) throw new Error("missing eval step");
function extractScript(step: string): string {
  const script = step
    .split("        run: |\n")[1]
    ?.split("\n")
    .filter((line) => line.startsWith("          ") || line === "")
    .map((line) => line.slice(10))
    .join("\n");
  if (script === undefined) throw new Error("missing eval shell");

  return script;
}
const script = extractScript(evalStep);

function runShell(
  inputs: Record<string, string>,
  exitCode = 0,
): { status: number | null; args: string[] | null } {
  const dir = mkdtempSync(join(tmpdir(), "eval-workflow-"));
  const capture = join(dir, "args");
  writeFileSync(
    join(dir, "pnpm"),
    '#!/bin/bash\nprintf "%s\\0" "$@" > "$CAPTURE"\nexit "$STUB_EXIT"\n',
    { mode: 0o755 },
  );
  try {
    const result = spawnSync("/bin/bash", ["-c", script], {
      // Do not inherit credentials or invoke the real pnpm.
      env: {
        PATH: dir,
        CAPTURE: capture,
        STUB_EXIT: String(exitCode),
        INPUT_K: "",
        INPUT_MAX_CALLS: "",
        INPUT_CATEGORY: "",
        ...inputs,
      },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      args: existsSync(capture)
        ? readFileSync(capture, "utf8").split("\0").slice(0, -1)
        : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("manual live workflow", () => {
  it("scopes the secret to eval, binds inputs via env, and always uploads with a missing-file warning", () => {
    const active = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(active).toContain("  workflow_dispatch:");
    expect(active).not.toMatch(/^\s+(push|pull_request):/m);
    expect(active.match(/secrets\.ANTHROPIC_API_KEY/g)).toHaveLength(1);
    expect(evalStep).toContain(
      "        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    );
    for (const [field, input] of [
      ["K", "k"],
      ["MAX_CALLS", "max_calls"],
      ["CATEGORY", "category"],
    ]) {
      expect(evalStep).toContain(
        "INPUT_" + field + ": ${{ inputs." + input + " }}",
      );
    }
    expect(script).not.toContain("${{");
    expect(active).toMatch(
      /actions\/upload-artifact@[^\n]+\n {8}if: always\(\)/,
    );
    expect(active).toContain("if-no-files-found: warn");
  });

  it.each(["INPUT_K", "INPUT_MAX_CALLS", "INPUT_CATEGORY"])(
    "rejects malformed %s without invoking pnpm",
    (field) => {
      for (const value of [
        "1; exit 0",
        "$(echo injected)",
        "two words",
        "1\n2",
      ]) {
        expect(runShell({ [field]: value })).toEqual({ status: 3, args: null });
      }
    },
  );

  it.each([0, 1, 3])(
    "preserves separate arguments and pnpm exit %i",
    (code) => {
      expect(
        runShell(
          {
            INPUT_K: "2",
            INPUT_MAX_CALLS: "100",
            INPUT_CATEGORY: "injection-test_1",
          },
          code,
        ),
      ).toEqual({
        status: code,
        args: [
          "--filter",
          "@apo/agent-evals",
          "eval:live",
          "--k",
          "2",
          "--max-calls",
          "100",
          "--category",
          "injection-test_1",
        ],
      });
    },
  );

  it("leaves omitted inputs to CLI defaults", () => {
    expect(runShell({})).toEqual({
      status: 0,
      args: ["--filter", "@apo/agent-evals", "eval:live"],
    });
  });
});
