/**
 * Prints each scenario beat to stdout as it happens. Kept separate from
 * `scenarios.ts` so scenario logic stays pure (return a typed result) and
 * `scenarios.test.ts` can assert on the returned `ScenarioResult` without
 * capturing console output.
 */
import type { ScenarioBeat, ScenarioResult } from "./scenarios.js";

export function narrateBeat(beat: ScenarioBeat): void {
  console.log(`  · ${beat.name}`);
  if (beat.detail !== undefined) {
    console.log(`    ${beat.detail}`);
  }
}

export function narrateHeader(scenarioId: string, title: string): void {
  console.log(`\n=== Scenario ${scenarioId.toUpperCase()} — ${title} ===`);
}

export function narrateResult(result: ScenarioResult): void {
  if (result.passed) {
    console.log(`\n✓ Scenario ${result.id.toUpperCase()} passed.`);
  } else {
    console.log(
      `\n✗ Scenario ${result.id.toUpperCase()} FAILED: ${result.failure ?? "unknown assertion failure"}`,
    );
  }
}
