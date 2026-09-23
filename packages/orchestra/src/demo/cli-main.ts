/**
 * `pnpm --filter @apo/orchestra demo` — drives the already-running
 * docker-compose stack over HTTP through one, two, or all three demo
 * scenarios (`scenarios.ts`). Talks DIRECTLY to each compose port
 * (`agent-orchestrator`:3200, `durable-ledger`:3100, `pay-core`:3000), not
 * through the `orchestra` gateway (:3300) — the gateway exists for a public
 * visitor, not a local developer running this CLI (`docs/todo/05-orchestra.md
 * §10`).
 *
 * Exit codes (mirrors `@apo/agent-evals`'s CLI exit-code discipline):
 *   0 — every requested scenario's beats held.
 *   1 — at least one scenario's own assertion failed (a real guardrail/
 *       demo-behaviour mismatch).
 *   3 — a harness/connection error (a service unreachable, an unparseable
 *       response, a timeout) — distinct from 1 because it says nothing
 *       about whether the system under test is actually broken.
 */
import {
  AgentOrchestratorClient,
  DemoClientError,
  DurableLedgerClient,
  PayCoreClient,
} from "./client.js";
import { narrateBeat, narrateHeader, narrateResult } from "./narrate.js";
import {
  SCENARIOS,
  type ScenarioId,
  type ScenarioResult,
} from "./scenarios.js";

interface CliOptions {
  readonly scenario: ScenarioId | "all";
  readonly baseUrl: string;
  readonly ledgerUrl: string;
  readonly ledgerServiceSecret: string;
  readonly payCoreUrl: string;
  readonly customerId: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}

const HELP_TEXT = `Usage: pnpm --filter @apo/orchestra demo [options]

Options:
  --scenario <a|b|c|all>   Which demo scenario(s) to run (default: all)
  --base-url <url>         agent-orchestrator base URL (default: http://localhost:3200)
  --ledger-url <url>       durable-ledger base URL (default: http://localhost:3100)
  --pay-core-url <url>     pay-core base URL, used only for the preflight health
                           check (default: http://localhost:3000)
  --customer-id <id>       X-Customer-Id prefix (default: demo-customer)
  --timeout-ms <n>         per-HTTP-request timeout in ms (default: 10000)
  --json                   print machine-readable JSON instead of narration
  --help                   show this message

Environment:
  DURABLE_LEDGER_SERVICE_SECRET  required shared secret for ledger reads
`;

class CliUsageError extends Error {}

function parseArgs(argv: readonly string[]): CliOptions | null {
  let scenario: string = "all";
  let baseUrl = "http://localhost:3200";
  let ledgerUrl = "http://localhost:3100";
  let payCoreUrl = "http://localhost:3000";
  let customerId = "demo-customer";
  let timeoutMs = 10_000;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
        return null;
      case "--scenario":
        scenario = argv[(i += 1)] ?? "";
        break;
      case "--base-url":
        baseUrl = argv[(i += 1)] ?? "";
        break;
      case "--ledger-url":
        ledgerUrl = argv[(i += 1)] ?? "";
        break;
      case "--pay-core-url":
        payCoreUrl = argv[(i += 1)] ?? "";
        break;
      case "--customer-id":
        customerId = argv[(i += 1)] ?? "";
        break;
      case "--timeout-ms": {
        const raw = argv[(i += 1)] ?? "";
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new CliUsageError(
            `--timeout-ms must be a positive integer, got "${raw}"`,
          );
        }
        timeoutMs = parsed;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        throw new CliUsageError(`Unrecognized argument: "${arg ?? ""}"`);
    }
  }

  if (
    scenario !== "a" &&
    scenario !== "b" &&
    scenario !== "c" &&
    scenario !== "all"
  ) {
    throw new CliUsageError(
      `--scenario must be one of a|b|c|all, got "${scenario}"`,
    );
  }

  const ledgerServiceSecret = process.env.DURABLE_LEDGER_SERVICE_SECRET;
  if (ledgerServiceSecret === undefined || ledgerServiceSecret.length < 32) {
    throw new CliUsageError(
      "DURABLE_LEDGER_SERVICE_SECRET must be set to at least 32 characters",
    );
  }

  return {
    scenario,
    baseUrl,
    ledgerUrl,
    ledgerServiceSecret,
    payCoreUrl,
    customerId,
    timeoutMs,
    json,
  };
}

async function preflight(options: CliOptions): Promise<void> {
  const payCore = new PayCoreClient({
    baseUrl: options.payCoreUrl,
    timeoutMs: options.timeoutMs,
  });
  const healthy = await payCore.checkHealth();
  if (!healthy) {
    throw new DemoClientError(
      `pay-core at ${options.payCoreUrl} did not report healthy — is docker compose up?`,
    );
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    console.log(HELP_TEXT);
    return 0;
  }

  await preflight(options);

  const runId = Date.now().toString(36);
  const orchestrator = new AgentOrchestratorClient({
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  });
  const ledger = new DurableLedgerClient({
    baseUrl: options.ledgerUrl,
    timeoutMs: options.timeoutMs,
    serviceSecret: options.ledgerServiceSecret,
  });

  const ids: ScenarioId[] =
    options.scenario === "all" ? ["a", "b", "c"] : [options.scenario];

  const results: ScenarioResult[] = [];
  for (const id of ids) {
    const runner = SCENARIOS[id];
    const customerId = `${options.customerId}-${id}-${runId}`;
    if (!options.json) {
      narrateHeader(id, "running…");
    }
    const result = await runner({
      customerId,
      clients: { orchestrator, ledger },
    });
    if (!options.json) {
      for (const beat of result.beats) {
        narrateBeat(beat);
      }
      narrateResult(result);
    }
    results.push(result);
  }

  if (options.json) {
    console.log(JSON.stringify({ results }, null, 2));
  }

  return results.every((r) => r.passed) ? 0 : 1;
}

try {
  const exitCode = await main();
  process.exitCode = exitCode;
} catch (err) {
  if (err instanceof CliUsageError) {
    console.error(`orchestra demo: ${err.message}\n`);
    console.error(HELP_TEXT);
    process.exitCode = 3;
  } else if (err instanceof DemoClientError) {
    console.error(`orchestra demo: harness/connection error — ${err.message}`);
    process.exitCode = 3;
  } else {
    console.error("orchestra demo: unexpected failure", err);
    process.exitCode = 3;
  }
}
