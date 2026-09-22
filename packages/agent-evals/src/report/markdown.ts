/**
 * EvalReport (+ optional ReportDiff) -> Markdown. Pure.
 *
 * Every string that can be model- or scenario-controlled (merchantId, ids,
 * paths, messages) goes through `cell()`: control characters (newlines
 * included), `|`, backticks, `<`, `>`, `[` and `]` are stripped (no HTML tag
 * and no Markdown link can form) and the result is truncated to 64
 * characters (filesystem paths are stripped but not truncated), so a value can neither break a table cell nor start a new
 * heading line.
 */
import type { Rate } from "../metrics.js";
import type { ReportDiff } from "./diff.js";
import type {
  EvalReport,
  EvidenceSource,
  ObservationEvidence,
} from "./types.js";

const MAX_CELL = 64;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function cell(value: string): string {
  const s = value.replace(CONTROL, "").replace(/[|`<>[\]]/g, "");
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

/** Like `cell` without truncation: for harness-authored filesystem paths. */
function filePath(value: string): string {
  return value.replace(CONTROL, "").replace(/[|`<>[\]]/g, "");
}

const n = (v: number | null): string => (v === null ? "n/a" : String(v));

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  return [row(header), row(header.map(() => "---")), ...rows.map(row), ""];
}

function rateRow(name: string, r: Rate | null): string[] {
  return r === null
    ? [name, "n/a", "0", "n/a"]
    : [name, String(r.numerator), String(r.denominator), r.value.toFixed(3)];
}

function sourceLines(source: EvidenceSource): string[] {
  if (source.kind === "corpus") {
    return [`Corpus file: \`${filePath(source.file)}\``, ""];
  }
  const seed = filePath(source.seed);
  return [
    `Fuzz case: seed ${seed} index ${String(source.index)}`,
    "",
    `Replay: \`pnpm --filter @apo/agent-evals eval:hostile --fuzz-seed ${seed} --fuzz-count ${String(source.index + 1)} --dump-fuzz <dir>\``,
    "",
  ];
}

function fuzzLines(f: EvalReport["fuzz"]): string[] {
  if (f === null) return ["Fuzz layer disabled.", ""];
  return [
    `- Seed: ${cell(f.seed)}`,
    `- Count: ${String(f.count)}`,
    `- Generator version: ${String(f.generator)}`,
    `- Scenarios: ${String(f.scenarios)}; start calls ${String(f.startCalls)}; safety violations ${String(f.safetyViolations)}; harness errors ${String(f.errors)}`,
    "",
  ];
}

/** `live.model` is env-controlled (`ANTHROPIC_MODEL`) and therefore untrusted, same as any other evidence field — sanitized through `cell()`. */
function liveLines(live: EvalReport["live"]): string[] {
  if (live === null) return ["Not a live run.", ""];
  const lines: string[] = [
    `- Model: ${cell(live.model)}`,
    `- k: ${String(live.k)}`,
    `- Budget: ${String(live.calls)} / ${String(live.maxCalls)} calls used`,
    `- Entries: ${String(live.scenariosRun)} run of ${String(live.scenariosPlanned)} planned`,
    "",
  ];
  if (live.stoppedEarly) {
    lines.push(
      `**PARTIAL: budget exhausted after ${String(live.scenariosRun)} of ${String(live.scenariosPlanned)} runs**`,
      "",
    );
  }
  lines.push(
    "Failures by code:",
    "",
    ...table(
      ["Code", "Count"],
      Object.entries(live.failuresByCode).map(([code, count]) => [
        cell(code),
        String(count),
      ]),
    ),
    "Live metrics:",
    "",
    ...table(
      ["Metric", "Numerator", "Denominator", "Value"],
      [
        rateRow("unsafeProposalRate", live.metrics.unsafeProposalRate),
        rateRow("gatedRate", live.metrics.gatedRate),
        rateRow("consistency", live.metrics.consistency),
        rateRow("passAtK", live.metrics.passAtK),
      ],
    ),
  );
  return lines;
}

function evidenceLines(e: ObservationEvidence): string[] {
  const lines: string[] = [
    ...sourceLines(e.source),
    `Observed policy: hard limit ${String(e.policy.maxHardLimitAmount)}, auto-approve ${String(e.policy.maxAutoApproveAmount)}, daily rate limit ${String(e.policy.dailyRateLimit)}, currencies ${e.policy.allowedCurrencies.map(cell).join(", ")}`,
    "",
    "Intents:",
    "",
    ...table(
      ["Id", "Idempotency key", "Statuses", "Final"],
      e.intents.map((i) => [
        cell(i.id),
        i.idempotencyKey === null ? "none" : cell(i.idempotencyKey),
        cell(i.statuses.join(" > ")),
        cell(i.finalStatus ?? "none"),
      ]),
    ),
    "Core calls:",
    "",
    ...table(
      ["Index", "Method", "Detail"],
      e.coreCalls.map((c) => [
        String(c.index),
        c.method,
        c.method === "startPaymentWorkflow"
          ? cell(
              `${String(c.amount)} ${c.currency} to ${c.merchantId} key ${c.idempotencyKey ?? "none"}`,
            )
          : cell(`${c.eventId} status ${c.status ?? "unknown"}`),
      ]),
    ),
    "HTTP exchanges:",
    "",
    ...table(
      ["Index", "Method", "Path", "Customer", "Status", "Core calls"],
      e.http.map((x) => [
        String(x.index),
        x.method,
        cell(x.path),
        cell(x.customerId),
        String(x.status),
        x.coreCallIndexes.join(", "),
      ]),
    ),
  ];
  return lines;
}

function diffLines(diff: ReportDiff | null): string[] {
  if (diff === null) return ["No previous run to compare against.", ""];
  const list = (items: readonly string[]): string =>
    items.length === 0 ? "none" : items.map(cell).join(", ");
  const keys = (items: ReportDiff["newViolations"]): string =>
    list(items.map((k) => `${k.scenarioId}/${k.invariant}`));
  return [
    `Baseline: \`${filePath(diff.baselineFile)}\` (started ${cell(diff.baselineStartedAt)})`,
    "",
    ...table(
      ["Metric", "Before", "After"],
      diff.metricDeltas.map((d) => [d.name, n(d.before), n(d.after)]),
    ),
    `- New violations: ${keys(diff.newViolations)}`,
    `- Fixed violations: ${keys(diff.fixedViolations)}`,
    `- Added scenarios: ${list(diff.addedScenarios)}`,
    `- Removed scenarios: ${list(diff.removedScenarios)}`,
    `- Newly failing scenarios: ${list(diff.newlyFailingScenarios)}`,
    `- Newly passing scenarios: ${list(diff.newlyPassingScenarios)}`,
    "",
  ];
}

export function renderMarkdown(
  report: EvalReport,
  diff: ReportDiff | null,
): string {
  const m = report.metrics;
  const lines: string[] = [
    `# agent-evals ${report.mode} report`,
    "",
    `- Started: ${report.startedAt}`,
    `- Duration: ${String(Math.round(report.durationMs))} ms`,
    `- Corpus: \`${filePath(report.corpus.dir)}\` (${String(report.corpus.scenarios)} scenarios)`,
    `- Report schema version: ${String(report.schemaVersion)}`,
    "",
    `**Gate ${report.gate.name} = ${String(report.gate.value)}: ${report.gate.pass ? "PASS" : "FAIL"}**`,
    "",
    "## Per-category results",
    "",
    ...table(
      [
        "Category",
        "Scenarios",
        "Safety violations",
        "Scenarios with violations",
        "Expectation failures",
        "Start calls",
        "Errors",
      ],
      Object.entries(m.byCategory).map(([name, c]) => [
        name,
        String(c.scenarios),
        String(c.safetyViolations),
        String(c.scenariosWithViolations),
        String(c.expectationFailures),
        String(c.startCalls),
        String(c.errors),
      ]),
    ),
    "## Informational metrics",
    "",
    "Only the safety-violations gate can fail a run; these carry no threshold.",
    "",
    ...table(
      ["Metric", "Numerator", "Denominator", "Value"],
      [
        rateRow("guardrailCatchRate", m.guardrailCatchRate),
        rateRow("falseRejectRate", m.falseRejectRate),
        rateRow("clarifyRate", m.clarifyRate),
      ],
    ),
    "## Live run",
    "",
    ...liveLines(report.live),
    "## Fuzz",
    "",
    ...fuzzLines(report.fuzz),
    "## Violations",
    "",
  ];

  if (report.violations.length === 0) {
    lines.push("No safety violations.", "");
  }
  for (const v of report.violations) {
    lines.push(
      `### ${cell(v.scenarioId)}: ${v.invariant}`,
      "",
      cell(v.message),
      "",
      `Category ${cell(v.category)}; core call ${n(v.coreCallIndex)}; HTTP exchange ${n(v.httpIndex)}; intent ${v.intentId === null ? "none" : cell(v.intentId)}`,
      "",
      ...evidenceLines(v.evidence),
    );
  }

  const failing = report.scenarios.filter(
    (s) => s.expectationFailures.length > 0 || s.error !== null,
  );
  lines.push("## Expectation failures and harness errors", "");
  if (failing.length === 0) lines.push("None.", "");
  for (const s of failing) {
    if (s.error !== null) {
      lines.push(
        `- ${cell(s.id)}: harness error ${cell(s.error.name)}: ${cell(s.error.message)}`,
      );
    }
    for (const f of s.expectationFailures) {
      lines.push(`- ${cell(s.id)}: ${cell(f.kind)}: ${cell(f.message)}`);
    }
  }
  if (failing.length > 0) lines.push("");

  lines.push(
    "## Vacuous invariants",
    "",
    m.vacuousInvariants.length === 0
      ? "None: every oracle examined at least one subject."
      : `No subjects examined anywhere in this run: ${m.vacuousInvariants.join(", ")}`,
    "",
    "## Diff vs previous run",
    "",
    ...diffLines(diff),
  );
  return lines.join("\n");
}
