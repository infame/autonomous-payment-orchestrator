/**
 * Scenario runner. Drives a fresh in-memory agent-orchestrator purely through
 * its HTTP surface (`app.request`), never through use-cases directly, and
 * returns an `Observation` for oracles to judge.
 *
 * Every Step maps 1:1 to an HTTP call. `get` IS the sync: GET /intents/:id
 * can move an intent executing -> completed. After the steps the runner
 * issues one trailing GET per known intent (submission order, always as the
 * owner) and takes each `ObservedIntent.finalView` from that exchange's own
 * response (null when it carried no intent view). Intent ids are read from
 * the 201 bodies (deriveIntentId is not exported). Intents are deduped by id:
 * a same-key resubmit (ADR-0015) appends a view to the existing entry.
 * `as` overrides X-Customer-Id for one id-addressed exchange (foreign
 * caller); such exchanges land only in `http`, never in an intent's views.
 * Foreign submits are not supported. `intentId`/`finalView` on Observation
 * alias intents[0].
 *
 * Step `intent` selector: `intent` indexes `Observation.intents` (deduped by
 * id, submission order) - NOT the sequence of `submit` steps; a same-key
 * resubmit does not add an entry. Omitted => the most recently submitted
 * intent. An out-of-range index, or any step after a submit that returned no
 * view (4xx/5xx), throws `ScenarioStepError` - the harness never silently
 * drops a step, because a skipped approve would turn a missing effect into a
 * false green.
 *
 * `Observation.coreCalls` is sliced from the recorder's journal length
 * captured before the first exchange, so a reused injected recorder's earlier
 * (foreign) calls are excluded; `coreCallIndexes` stay absolute journal indexes.
 *
 * `coreCallIndexes` (core journal indexes made DURING one exchange) are
 * ABSOLUTE journal indexes: match them against `RecordedCoreCall.index`, not
 * against a position in `Observation.coreCalls`, which is sliced from the
 * run's start. Attribution (core call -> exchange -> intent) is sound only because
 * exchanges are awaited sequentially and `as` is id-addressed-only; revisit
 * when parallel-duplicate scenarios arrive.
 */
import { createInMemoryAgentOrchestrator } from "@apo/agent-orchestrator";
import type {
  IntentView,
  LlmClient,
  PolicyConfig,
} from "@apo/agent-orchestrator";
import { RecordingAgentCoreClient } from "./core/recording-agent-core-client.js";
import type { RecordedCoreCall } from "./core/recording-agent-core-client.js";

export class ScenarioStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioStepError";
  }
}

export type Step =
  | { readonly kind: "submit"; readonly idempotencyKey?: string }
  | {
      readonly kind: "clarify";
      readonly answer: string;
      readonly as?: string;
      readonly intent?: number;
    }
  | {
      readonly kind: "approve";
      readonly as?: string;
      readonly intent?: number;
    }
  | {
      readonly kind: "reject";
      readonly as?: string;
      readonly intent?: number;
    }
  | { readonly kind: "get"; readonly as?: string; readonly intent?: number };

export interface ScenarioRunInput {
  readonly id: string;
  readonly customerId: string;
  readonly text: string;
  /** Sent as the Idempotency-Key header on submit; the ONLY way to reach auto-approve. */
  readonly idempotencyKey?: string;
  readonly llm: LlmClient;
  readonly steps?: readonly Step[];
  /** Default: a fresh recorder. */
  readonly agentCore?: RecordingAgentCoreClient;
  /** Default "pm_evals_token". */
  readonly paymentMethodToken?: string;
  readonly policy?: Partial<PolicyConfig>;
  readonly clock?: () => Date;
}

export type IntentViewJson = Omit<IntentView, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

export interface HttpExchange {
  readonly index: number;
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Header actually sent (may be foreign, see Step `as`). */
  readonly customerId: string;
  readonly idempotencyKey: string | undefined;
  /** Intent addressed; null for a POST /intents that returned no view. */
  readonly intentId: string | null;
  readonly status: number;
  readonly body: unknown;
  /**
   * Core journal indexes made DURING this exchange. ABSOLUTE journal indexes:
   * match them against `RecordedCoreCall.index`, not against a position in
   * `Observation.coreCalls`, which is sliced from the run's start.
   */
  readonly coreCallIndexes: readonly number[];
}

export interface ObservedIntent {
  readonly id: string;
  /** Index into `http` of the POST /intents that first returned this id. */
  readonly submitExchangeIndex: number;
  readonly idempotencyKey: string | null;
  /** Owner-exchange views only, in order. */
  readonly views: readonly IntentViewJson[];
  /** From this intent's own trailing GET. */
  readonly finalView: IntentViewJson | null;
}

export interface Observation {
  readonly scenarioId: string;
  /** OWNER; any exchange with a different customerId is foreign. */
  readonly customerId: string;
  /** ORIGINAL scenario text as the harness sent it; never read back from a view. */
  readonly text: string;
  /** Only answers whose clarify exchange was 2xx. */
  readonly clarificationAnswers: readonly string[];
  readonly intents: readonly ObservedIntent[];
  /** Alias of intents[0]?.id. */
  readonly intentId: string | null;
  /** Every view from every exchange. */
  readonly views: readonly IntentViewJson[];
  /** Alias of intents[0]?.finalView. */
  readonly finalView: IntentViewJson | null;
  readonly coreCalls: readonly RecordedCoreCall[];
  readonly http: readonly HttpExchange[];
  readonly policy: PolicyConfig;
}

interface MutableIntent {
  readonly id: string;
  readonly submitExchangeIndex: number;
  readonly idempotencyKey: string | null;
  readonly views: IntentViewJson[];
  finalView: IntentViewJson | null;
}

interface ExchangeResult {
  readonly status: number;
  readonly view: IntentViewJson | null;
  readonly httpIndex: number;
}

interface IntentEnvelopeJSON {
  readonly intent?: IntentViewJson;
}

export async function runScenario(
  input: ScenarioRunInput,
): Promise<Observation> {
  const agentCore = input.agentCore ?? new RecordingAgentCoreClient();
  const { app, policy } = createInMemoryAgentOrchestrator({
    llm: input.llm,
    agentCore,
    paymentMethodToken: input.paymentMethodToken ?? "pm_evals_token",
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });

  const journalStart = agentCore.calls.length;
  const http: HttpExchange[] = [];
  const views: IntentViewJson[] = [];
  const clarificationAnswers: string[] = [];
  const intents: MutableIntent[] = [];

  const exchange = async (
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown;
      idempotencyKey?: string;
      customerId?: string;
      intentId?: string;
    } = {},
  ): Promise<ExchangeResult> => {
    const customerId = opts.customerId ?? input.customerId;
    const before = agentCore.calls.length;
    const res = await app.request(path, {
      method,
      headers: {
        "X-Customer-Id": customerId,
        ...(opts.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": opts.idempotencyKey }),
        ...(opts.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const parsed: unknown = await res.json();
    const after = agentCore.calls.length;
    const coreCallIndexes: number[] = [];
    for (let i = before; i < after; i += 1) coreCallIndexes.push(i);
    const view = (parsed as IntentEnvelopeJSON).intent;
    const httpIndex = http.length;
    http.push({
      index: httpIndex,
      method,
      path,
      customerId,
      idempotencyKey: opts.idempotencyKey,
      intentId: opts.intentId ?? view?.id ?? null,
      status: res.status,
      body: parsed,
      coreCallIndexes,
    });
    if (view !== undefined) views.push(view);
    return { status: res.status, view: view ?? null, httpIndex };
  };

  const submit = async (
    idempotencyKey: string | undefined,
  ): Promise<boolean> => {
    const result = await exchange("POST", "/intents", {
      body: { text: input.text },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (result.view === null) return false;
    const existing = intents.find((i) => i.id === result.view?.id);
    if (existing === undefined) {
      intents.push({
        id: result.view.id,
        submitExchangeIndex: result.httpIndex,
        idempotencyKey: idempotencyKey ?? null,
        views: [result.view],
        finalView: null,
      });
    } else {
      existing.views.push(result.view);
    }
    return true;
  };

  const ownerExchange = async (
    target: MutableIntent,
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<ExchangeResult> => {
    const result = await exchange(method, path, {
      ...opts,
      intentId: target.id,
    });
    if (result.view !== null) target.views.push(result.view);
    return result;
  };

  let lastSubmitHadView = await submit(input.idempotencyKey);

  let stepIndex = -1;
  for (const step of input.steps ?? []) {
    stepIndex += 1;
    if (step.kind === "submit") {
      lastSubmitHadView = await submit(step.idempotencyKey);
      continue;
    }
    if (!lastSubmitHadView) {
      throw new ScenarioStepError(
        `step ${String(stepIndex)} (${step.kind}) follows a submit that returned no intent view`,
      );
    }
    const target =
      step.intent === undefined ? intents.at(-1) : intents[step.intent];
    if (target === undefined) {
      throw new ScenarioStepError(
        `step ${String(stepIndex)} (${step.kind}) targets intent ${step.intent === undefined ? "(most recent)" : String(step.intent)} but only ${String(intents.length)} intent(s) are known`,
      );
    }
    const path = `/intents/${target.id}`;
    const method = step.kind === "get" ? "GET" : "POST";
    const suffix = step.kind === "get" ? "" : `/${step.kind}`;
    const body = step.kind === "clarify" ? { answer: step.answer } : undefined;
    let result: ExchangeResult;
    if (step.as === undefined) {
      result = await ownerExchange(target, method, `${path}${suffix}`, {
        ...(body === undefined ? {} : { body }),
      });
    } else {
      result = await exchange(method, `${path}${suffix}`, {
        ...(body === undefined ? {} : { body }),
        customerId: step.as,
        intentId: target.id,
      });
    }
    if (
      step.kind === "clarify" &&
      step.as === undefined &&
      result.status >= 200 &&
      result.status < 300
    ) {
      clarificationAnswers.push(step.answer);
    }
  }

  for (const target of intents) {
    target.finalView = (
      await ownerExchange(target, "GET", `/intents/${target.id}`)
    ).view;
  }

  return {
    scenarioId: input.id,
    customerId: input.customerId,
    text: input.text,
    clarificationAnswers,
    intents,
    intentId: intents[0]?.id ?? null,
    views,
    finalView: intents[0]?.finalView ?? null,
    coreCalls: agentCore.calls.slice(journalStart),
    http,
    policy,
  };
}
