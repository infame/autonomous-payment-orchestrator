/**
 * Scenario schema (spec 04 §3) and sync JSON loader. Zod validates shape; the
 * domain constructors in llm/proposal-from-json.ts gate scripted proposals and
 * are run eagerly at load so a bad proposal fails at LOAD, not at run.
 * `llm.mode: "live"` is deliberately absent: live mode arrives with the CLI.
 * `description` is prose for reports/reviewers and is never read by the
 * harness. `expect.coreCalls` counts `startPaymentWorkflow` calls only
 * (`getRunStatus` is excluded).
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { isIntentStatus, isPolicyReasonCode } from "@apo/agent-orchestrator";
import type { IntentStatus, PolicyReasonCode } from "@apo/agent-orchestrator";
import { z } from "zod";
import { buildProposal } from "./llm/proposal-from-json.js";

export const ScenarioCategory = z.enum([
  "benign",
  "ambiguous",
  "injection",
  "limits",
  "duplicate",
  "tenancy",
  "clarify-abuse",
]);

const IntentStatusSchema = z.custom<IntentStatus>(
  (v) => typeof v === "string" && isIntentStatus(v),
  { message: "not an IntentStatus" },
);
const PolicyReasonSchema = z.custom<PolicyReasonCode>(
  (v) => typeof v === "string" && isPolicyReasonCode(v),
  { message: "not a PolicyReasonCode" },
);
const InvariantIdSchema = z.enum([
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "I7",
  "I8",
]);

const ProposalJsonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("propose_payment"),
    amount: z.number(),
    currency: z.string(),
    merchantId: z.string(),
    reasoning: z.string(),
  }),
  z.object({ kind: z.literal("clarify"), question: z.string() }),
  z.object({ kind: z.literal("decline"), reason: z.string() }),
]);

const MockOutcomeJson = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("payment"),
    selector: z.enum(["min", "max", "ungrounded"]),
  }),
  z.object({ kind: z.literal("clarify"), slug: z.string() }),
  z.object({ kind: z.literal("decline"), slug: z.string() }),
  z.object({ kind: z.literal("unavailable") }),
]);

const StepIntent = z.number().int().min(0).optional();

const ScenarioStep = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("submit"),
    idempotencyKey: z.string().optional(),
  }),
  z.object({
    kind: z.literal("clarify"),
    answer: z.string(),
    as: z.string().optional(),
    intent: StepIntent,
  }),
  z.object({
    kind: z.literal("approve"),
    as: z.string().optional(),
    intent: StepIntent,
  }),
  z.object({
    kind: z.literal("reject"),
    as: z.string().optional(),
    intent: StepIntent,
  }),
  z.object({
    kind: z.literal("get"),
    as: z.string().optional(),
    intent: StepIntent,
  }),
]);

export const Scenario = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    category: ScenarioCategory,
    description: z.string().min(1),
    customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    text: z.string().min(1),
    /** Sent as Idempotency-Key on the FIRST submit; the only auto-approve trigger. */
    idempotencyKey: z
      .string()
      .regex(/^[\x21-\x7E]{1,200}$/)
      .optional(),
    paymentMethodToken: z.string().min(1).optional(),
    policy: z
      .object({
        allowedCurrencies: z.array(z.string()).optional(),
        maxAutoApproveAmount: z.number().optional(),
        maxHardLimitAmount: z.number().optional(),
        dailyRateLimit: z.number().optional(),
      })
      .optional(),
    agentCore: z
      .object({
        runStatus: z
          .enum(["queued", "running", "completed", "failed", "cancelled"])
          .optional(),
      })
      .optional(),
    llm: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("script"),
        proposals: z.array(ProposalJsonSchema).min(1),
      }),
      z.object({
        mode: z.literal("mock"),
        config: z
          .object({
            defaultOutcome: MockOutcomeJson.optional(),
            defaultCurrency: z.string().optional(),
            defaultMerchantId: z.string().optional(),
          })
          .optional(),
      }),
    ]),
    steps: z.array(ScenarioStep).optional(),
    expect: z.object({
      /** Allowed finalView.status for EVERY observed intent. */
      terminal: z.array(IntentStatusSchema).min(1),
      /** startPaymentWorkflow calls ONLY; getRunStatus is excluded. */
      coreCalls: z
        .object({
          min: z.number().int().min(0),
          max: z.number().int().min(0),
        })
        .refine((c) => c.min <= c.max, { message: "coreCalls.min > max" }),
      /** finalView.policyVerdict.reason of the first intent. */
      rejectionReason: PolicyReasonSchema.optional(),
      /** Exact ordered amounts of start calls. */
      startAmounts: z.array(z.number().int()).optional(),
      /** Oracles whose subjects must be > 0. */
      nonVacuous: z.array(InvariantIdSchema).optional(),
    }),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

export class ScenarioLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioLoadError";
  }
}

export function parseScenario(source: string, raw: string): Scenario {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ScenarioLoadError(
      `${source}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = Scenario.safeParse(json);
  if (!parsed.success) {
    const id =
      typeof json === "object" &&
      json !== null &&
      "id" in json &&
      typeof json.id === "string"
        ? ` (scenario "${json.id}")`
        : "";
    throw new ScenarioLoadError(
      `${source}${id}: schema violation: ${JSON.stringify(parsed.error.flatten())}`,
    );
  }
  const scenario = parsed.data;
  if (scenario.llm.mode === "script") {
    for (const [i, p] of scenario.llm.proposals.entries()) {
      try {
        buildProposal(p);
      } catch (err) {
        throw new ScenarioLoadError(
          `${source} (scenario "${scenario.id}"): scripted proposal ${String(i)} rejected by domain constructor: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return scenario;
}

const DEFAULT_CORPUS_DIR = new URL("./corpus/", import.meta.url);

export function loadCorpus(
  dir: string | URL = DEFAULT_CORPUS_DIR,
): readonly Scenario[] {
  const dirPath = typeof dir === "string" ? dir : fileURLToPath(dir);
  const files = readdirSync(dirPath)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const seen = new Map<string, string>();
  const out: Scenario[] = [];
  for (const file of files) {
    const path = join(dirPath, file);
    const scenario = parseScenario(path, readFileSync(path, "utf8"));
    if (basename(file, ".json") !== scenario.id) {
      throw new ScenarioLoadError(
        `${path}: filename does not match scenario id "${scenario.id}"`,
      );
    }
    // Defensive only: unreachable while basename === id is enforced above;
    // kept for a future non-file loader.
    const other = seen.get(scenario.id);
    if (other !== undefined) {
      throw new ScenarioLoadError(
        `${path}: duplicate scenario id "${scenario.id}" (also in ${other})`,
      );
    }
    seen.set(scenario.id, path);
    out.push(scenario);
  }
  return out;
}
