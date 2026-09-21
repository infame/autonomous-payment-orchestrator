/**
 * Process entrypoint for `pnpm eval:hostile`. Not exported from the package:
 * it only ever runs directly (via tsx). All logic lives in `runCli`; this
 * file wires the real process and turns an unexpected throw into one clear
 * line and the harness-error exit code, mirroring
 * `@apo/agent-orchestrator`'s `main.ts`.
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
  });
} catch (err) {
  console.error("agent-evals: eval:hostile failed", err);
  process.exitCode = EXIT.harnessError;
}
