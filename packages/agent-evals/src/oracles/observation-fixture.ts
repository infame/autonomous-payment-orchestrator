/**
 * Hand-built Observation pieces for oracle tests. Defaults are benign
 * ("Pay $120 to acme for invoice 42", 12000 USD acme, default policy).
 *
 * Deliberately does NOT auto-link core calls to exchanges: every mutant spells
 * out `coreCallIndexes` itself, so the attribution under test is explicit.
 */
import { DEFAULT_POLICY_CONFIG } from "@apo/agent-orchestrator";
import type {
  RecordedGetRunStatusCall,
  RecordedStartCall,
} from "../core/recording-agent-core-client.js";
import type {
  HttpExchange,
  IntentViewJson,
  Observation,
  ObservedIntent,
} from "../runner.js";

export const BENIGN_TEXT = "Pay $120 to acme for invoice 42";
export const OWNER = "cust_owner";

export function view(overrides: Partial<IntentViewJson> = {}): IntentViewJson {
  return {
    id: "intent_1",
    customerId: OWNER,
    text: BENIGN_TEXT,
    status: "executing",
    proposal: null,
    policyVerdict: null,
    durableLedgerEventId: null,
    clarificationAnswer: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function observedIntent(
  overrides: Partial<ObservedIntent> = {},
): ObservedIntent {
  const v = view({
    ...(overrides.id === undefined ? {} : { id: overrides.id }),
  });
  return {
    id: "intent_1",
    submitExchangeIndex: 0,
    idempotencyKey: null,
    views: [v],
    finalView: v,
    ...overrides,
  };
}

export function startCall(
  overrides: Partial<RecordedStartCall> = {},
): RecordedStartCall {
  return {
    index: 0,
    method: "startPaymentWorkflow",
    request: {
      amount: 12000,
      currency: "USD",
      merchantId: "acme",
      paymentMethodToken: "pm_fixture",
    },
    idempotencyKey: "intent_1",
    eventId: "evt_1",
    ...overrides,
  };
}

export function getRunStatusCall(
  overrides: Partial<RecordedGetRunStatusCall> = {},
): RecordedGetRunStatusCall {
  return {
    index: 0,
    method: "getRunStatus",
    eventId: "evt_1",
    snapshot: null,
    ...overrides,
  };
}

export function exchange(overrides: Partial<HttpExchange> = {}): HttpExchange {
  return {
    index: 0,
    method: "POST",
    path: "/intents",
    customerId: OWNER,
    idempotencyKey: undefined,
    intentId: "intent_1",
    status: 201,
    body: {},
    coreCallIndexes: [],
    ...overrides,
  };
}

export function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    scenarioId: "fixture",
    customerId: OWNER,
    text: BENIGN_TEXT,
    clarificationAnswers: [],
    intents: [observedIntent()],
    intentId: "intent_1",
    views: [],
    finalView: null,
    coreCalls: [],
    http: [exchange()],
    policy: DEFAULT_POLICY_CONFIG,
    ...overrides,
  };
}
