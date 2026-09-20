/**
 * Scenario runner. Drives a fresh in-memory agent-orchestrator purely through
 * its HTTP surface (`app.request`), never through use-cases directly, and
 * returns an `Observation` for oracles to judge.
 *
 * Every Step maps 1:1 to an HTTP call. `get` IS the sync: GET /intents/:id
 * can move an intent executing -> completed. The runner always issues one
 * final GET (skipped when no intent id was obtained) and takes `finalView`
 * from that exchange's own response (null when it carried no intent view).
 * The intent id is read from the 201 body (deriveIntentId is not
 * exported).
 *
 * `Observation.coreCalls` is sliced from the recorder's journal length
 * captured before the first exchange, so a reused injected recorder's earlier
 * (foreign) calls are excluded; `coreCallIndexes` stay absolute journal indexes.
 *
 * `coreCallIndexes` attribution (core journal indexes made during one
 * exchange) is only correct because requests are awaited sequentially;
 * revisit when parallel-duplicate scenarios arrive.
 */
import { createInMemoryAgentOrchestrator } from "@apo/agent-orchestrator";
import type {
  IntentView,
  LlmClient,
  PolicyConfig,
} from "@apo/agent-orchestrator";
import { RecordingAgentCoreClient } from "./core/recording-agent-core-client.js";
import type { RecordedCoreCall } from "./core/recording-agent-core-client.js";

export type Step =
  | { readonly kind: "clarify"; readonly answer: string }
  | { readonly kind: "approve" }
  | { readonly kind: "reject" }
  | { readonly kind: "get" };

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
  readonly customerId: string;
  readonly idempotencyKey: string | undefined;
  readonly status: number;
  readonly body: unknown;
  /** Core journal indexes made DURING this exchange. */
  readonly coreCallIndexes: readonly number[];
}

export interface Observation {
  readonly scenarioId: string;
  readonly customerId: string;
  readonly text: string;
  readonly clarificationAnswers: readonly string[];
  readonly intentId: string | null;
  readonly views: readonly IntentViewJson[];
  readonly finalView: IntentViewJson | null;
  readonly coreCalls: readonly RecordedCoreCall[];
  readonly http: readonly HttpExchange[];
  readonly policy: PolicyConfig;
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
  let intentId: string | null = null;
  let finalView: IntentViewJson | null = null;

  const exchange = async (
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<IntentViewJson | null> => {
    const before = agentCore.calls.length;
    const res = await app.request(path, {
      method,
      headers: {
        "X-Customer-Id": input.customerId,
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
    http.push({
      index: http.length,
      method,
      path,
      customerId: input.customerId,
      idempotencyKey: opts.idempotencyKey,
      status: res.status,
      body: parsed,
      coreCallIndexes,
    });
    const view = (parsed as IntentEnvelopeJSON).intent;
    if (view !== undefined) views.push(view);
    return view ?? null;
  };

  const submitted = await exchange("POST", "/intents", {
    body: { text: input.text },
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  });
  intentId = submitted?.id ?? null;

  if (intentId !== null) {
    for (const step of input.steps ?? []) {
      switch (step.kind) {
        case "clarify":
          await exchange("POST", `/intents/${intentId}/clarify`, {
            body: { answer: step.answer },
          });
          if (http[http.length - 1]?.status.toString().startsWith("2")) {
            clarificationAnswers.push(step.answer);
          }
          break;
        case "approve":
          await exchange("POST", `/intents/${intentId}/approve`);
          break;
        case "reject":
          await exchange("POST", `/intents/${intentId}/reject`);
          break;
        case "get":
          await exchange("GET", `/intents/${intentId}`);
          break;
      }
    }
    finalView = await exchange("GET", `/intents/${intentId}`);
  }

  return {
    scenarioId: input.id,
    customerId: input.customerId,
    text: input.text,
    clarificationAnswers,
    intentId,
    views,
    finalView,
    coreCalls: agentCore.calls.slice(journalStart),
    http,
    policy,
  };
}
