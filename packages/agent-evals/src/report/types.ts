/**
 * Report shapes (`schemaVersion` 1) and the Zod schema used to parse an
 * UNTRUSTED baseline file back in. The interfaces and the schema mirror each
 * other 1:1; `parseReport` is the only reader.
 *
 * Redaction rule (same hygiene as `oracles/types.ts`): a report carries
 * reason codes, numbers, ids, statuses and paths ONLY. It never contains
 * `proposal.reasoning`, `policyVerdict.detail`, any HTTP body, or scenario
 * `text`/`description`. `merchantId` IS included (it is evidence) and is
 * model-controlled, so the Markdown renderer sanitizes it.
 */
import { z } from "zod";
import type { HarnessError } from "../eval-run.js";
import type { Metrics } from "../metrics.js";
import type { InvariantId } from "../oracles/index.js";

export interface EvidencePolicy {
  readonly allowedCurrencies: readonly string[];
  readonly maxAutoApproveAmount: number;
  readonly maxHardLimitAmount: number;
  readonly dailyRateLimit: number;
}

export type EvidenceCoreCall =
  | {
      readonly index: number;
      readonly method: "startPaymentWorkflow";
      readonly amount: number;
      readonly currency: string;
      readonly merchantId: string;
      readonly idempotencyKey: string | null;
    }
  | {
      readonly index: number;
      readonly method: "getRunStatus";
      readonly eventId: string;
      readonly status: string | null;
    };

export interface ObservationEvidence {
  /** Pointer `<corpusDir>/<id>.json`; does not echo hostile text. */
  readonly corpusFile: string;
  readonly policy: EvidencePolicy;
  readonly intents: readonly {
    readonly id: string;
    readonly idempotencyKey: string | null;
    readonly statuses: readonly string[];
    readonly finalStatus: string | null;
  }[];
  readonly coreCalls: readonly EvidenceCoreCall[];
  readonly http: readonly {
    readonly index: number;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly customerId: string;
    readonly status: number;
    readonly coreCallIndexes: readonly number[];
  }[];
}

export interface ReportedViolation {
  readonly scenarioId: string;
  readonly category: string;
  readonly invariant: InvariantId;
  readonly message: string;
  readonly coreCallIndex: number | null;
  readonly httpIndex: number | null;
  readonly intentId: string | null;
  readonly evidence: ObservationEvidence;
}

export interface ScenarioReport {
  readonly id: string;
  readonly category: string;
  /** No violations, no expectation failures, no harness error. */
  readonly ok: boolean;
  readonly durationMs: number;
  readonly safetyViolations: number;
  readonly expectationFailures: readonly {
    readonly kind: string;
    readonly message: string;
  }[];
  readonly invariants: readonly {
    readonly id: InvariantId;
    readonly subjects: number;
    readonly violations: number;
  }[];
  readonly startCalls: number;
  readonly terminalStatuses: readonly (string | null)[];
  readonly error: HarnessError | null;
}

export interface EvalReport {
  readonly schemaVersion: 1;
  readonly mode: "hostile";
  /** ISO UTC. */
  readonly startedAt: string;
  readonly durationMs: number;
  readonly corpus: { readonly dir: string; readonly scenarios: number };
  readonly gate: {
    readonly name: "safety_violations";
    readonly value: number;
    readonly pass: boolean;
  };
  readonly metrics: Metrics;
  readonly scenarios: readonly ScenarioReport[];
  readonly violations: readonly ReportedViolation[];
  readonly baseline: {
    readonly file: string;
    readonly startedAt: string;
  } | null;
}

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

const RateSchema = z
  .object({
    numerator: z.number(),
    denominator: z.number(),
    value: z.number(),
  })
  .nullable();

const CategoryMetricsSchema = z.object({
  scenarios: z.number(),
  safetyViolations: z.number(),
  scenariosWithViolations: z.number(),
  expectationFailures: z.number(),
  scenariosWithExpectationFailures: z.number(),
  startCalls: z.number(),
  errors: z.number(),
});

const perInvariant = <T extends z.ZodTypeAny>(t: T) =>
  z.object({
    I1: t,
    I2: t,
    I3: t,
    I4: t,
    I5: t,
    I6: t,
    I7: t,
    I8: t,
  });

const MetricsSchema = z.object({
  scenarios: z.number(),
  errors: z.number(),
  safetyViolations: z.number(),
  violationsByInvariant: perInvariant(z.number()),
  expectationFailures: z.number(),
  scenariosWithExpectationFailures: z.number(),
  startCalls: z.number(),
  guardrailCatchRate: RateSchema,
  falseRejectRate: RateSchema,
  clarifyRate: RateSchema,
  byCategory: z.object({
    benign: CategoryMetricsSchema,
    ambiguous: CategoryMetricsSchema,
    injection: CategoryMetricsSchema,
    limits: CategoryMetricsSchema,
    duplicate: CategoryMetricsSchema,
    tenancy: CategoryMetricsSchema,
    "clarify-abuse": CategoryMetricsSchema,
  }),
  vacuousInvariants: z.array(InvariantIdSchema),
});

const EvidenceSchema = z.object({
  corpusFile: z.string(),
  policy: z.object({
    allowedCurrencies: z.array(z.string()),
    maxAutoApproveAmount: z.number(),
    maxHardLimitAmount: z.number(),
    dailyRateLimit: z.number(),
  }),
  intents: z.array(
    z.object({
      id: z.string(),
      idempotencyKey: z.string().nullable(),
      statuses: z.array(z.string()),
      finalStatus: z.string().nullable(),
    }),
  ),
  coreCalls: z.array(
    z.discriminatedUnion("method", [
      z.object({
        index: z.number(),
        method: z.literal("startPaymentWorkflow"),
        amount: z.number(),
        currency: z.string(),
        merchantId: z.string(),
        idempotencyKey: z.string().nullable(),
      }),
      z.object({
        index: z.number(),
        method: z.literal("getRunStatus"),
        eventId: z.string(),
        status: z.string().nullable(),
      }),
    ]),
  ),
  http: z.array(
    z.object({
      index: z.number(),
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      customerId: z.string(),
      status: z.number(),
      coreCallIndexes: z.array(z.number()),
    }),
  ),
});

export const EvalReportSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal("hostile"),
  startedAt: z.string(),
  durationMs: z.number(),
  corpus: z.object({ dir: z.string(), scenarios: z.number() }),
  gate: z.object({
    name: z.literal("safety_violations"),
    value: z.number(),
    pass: z.boolean(),
  }),
  metrics: MetricsSchema,
  scenarios: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      ok: z.boolean(),
      durationMs: z.number(),
      safetyViolations: z.number(),
      expectationFailures: z.array(
        z.object({ kind: z.string(), message: z.string() }),
      ),
      invariants: z.array(
        z.object({
          id: InvariantIdSchema,
          subjects: z.number(),
          violations: z.number(),
        }),
      ),
      startCalls: z.number(),
      terminalStatuses: z.array(z.string().nullable()),
      error: z.object({ name: z.string(), message: z.string() }).nullable(),
    }),
  ),
  violations: z.array(
    z.object({
      scenarioId: z.string(),
      category: z.string(),
      invariant: InvariantIdSchema,
      message: z.string(),
      coreCallIndex: z.number().nullable(),
      httpIndex: z.number().nullable(),
      intentId: z.string().nullable(),
      evidence: EvidenceSchema,
    }),
  ),
  baseline: z.object({ file: z.string(), startedAt: z.string() }).nullable(),
});

/** Untrusted JSON in, a typed report or null out. Never throws. */
export function parseReport(raw: unknown): EvalReport | null {
  const parsed = EvalReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
