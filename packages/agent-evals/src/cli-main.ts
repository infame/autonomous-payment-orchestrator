/**
 * Process entrypoint for both `pnpm eval:hostile` and `pnpm eval:live`
 * (`--mode` selects). Not exported from the package: it only ever runs
 * directly (via tsx). All logic lives in `runCli`; this file wires the real
 * process — including `process.env`, live mode's only source of a real
 * `ANTHROPIC_API_KEY` (`live-config.ts`'s `loadLiveConfig`) — and turns an
 * unexpected throw into one clear line and the harness-error exit code,
 * mirroring `@apo/agent-orchestrator`'s `main.ts`. `createLiveLlm` is
 * deliberately left undefined here: `runCli` defaults it to the real
 * `createLiveLlmClient` (`live/llm-factory.ts`) only when running for real,
 * never in a test (see `cli.ts`'s `CliDeps` header).
 */
import { EXIT, runCli } from "./cli.js";

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    now: () => new Date(),
    stdout: (line) => {
      console.log(line);
    },
    stderr: (line) => {
      console.error(line);
    },
    cwd: process.cwd(),
    env: process.env,
  });
} catch (err) {
  console.error(
    "agent-evals: run failed",
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
  process.exitCode = EXIT.harnessError;
}
