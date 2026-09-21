/**
 * Glue from a parsed `Scenario` to `runScenario`. The JSON step/policy shapes
 * mirror the runner's types 1:1 but pass through explicit conditional spreads
 * (exactOptionalPropertyTypes): z.infer objects are never spread directly.
 */
import { MockLlmClient } from "@apo/agent-orchestrator";
import type {
  LlmClient,
  MockLlmConfig,
  PolicyConfig,
} from "@apo/agent-orchestrator";
import { RecordingAgentCoreClient } from "./core/recording-agent-core-client.js";
import { buildProposal } from "./llm/proposal-from-json.js";
import { ScriptedLlmClient } from "./llm/scripted-llm-client.js";
import { runScenario } from "./runner.js";
import type { Observation, ScenarioRunInput, Step } from "./runner.js";
import type { Scenario } from "./scenario.js";

export interface CorpusRunOverrides {
  readonly policy?: Partial<PolicyConfig>;
  readonly agentCore?: RecordingAgentCoreClient;
}

type StepJson = NonNullable<Scenario["steps"]>[number];

export function buildLlmClient(llm: Scenario["llm"]): LlmClient {
  if (llm.mode === "script") {
    return new ScriptedLlmClient(llm.proposals.map(buildProposal));
  }
  const c = llm.config;
  const config: MockLlmConfig = {
    ...(c?.defaultOutcome === undefined
      ? {}
      : { defaultOutcome: c.defaultOutcome }),
    ...(c?.defaultCurrency === undefined
      ? {}
      : { defaultCurrency: c.defaultCurrency }),
    ...(c?.defaultMerchantId === undefined
      ? {}
      : { defaultMerchantId: c.defaultMerchantId }),
  };
  return new MockLlmClient(config);
}

function toStep(s: StepJson): Step {
  if (s.kind === "submit") {
    return {
      kind: "submit",
      ...(s.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: s.idempotencyKey }),
    };
  }
  const selector = {
    ...(s.as === undefined ? {} : { as: s.as }),
    ...(s.intent === undefined ? {} : { intent: s.intent }),
  };
  return s.kind === "clarify"
    ? { kind: "clarify", answer: s.answer, ...selector }
    : { kind: s.kind, ...selector };
}

function toPolicy(p: NonNullable<Scenario["policy"]>): Partial<PolicyConfig> {
  return {
    ...(p.allowedCurrencies === undefined
      ? {}
      : { allowedCurrencies: p.allowedCurrencies }),
    ...(p.maxAutoApproveAmount === undefined
      ? {}
      : { maxAutoApproveAmount: p.maxAutoApproveAmount }),
    ...(p.maxHardLimitAmount === undefined
      ? {}
      : { maxHardLimitAmount: p.maxHardLimitAmount }),
    ...(p.dailyRateLimit === undefined
      ? {}
      : { dailyRateLimit: p.dailyRateLimit }),
  };
}

export function runCorpusScenario(
  s: Scenario,
  o: CorpusRunOverrides = {},
): Promise<Observation> {
  const agentCore =
    o.agentCore ??
    new RecordingAgentCoreClient(
      s.agentCore?.runStatus === undefined
        ? {}
        : { runStatus: s.agentCore.runStatus },
    );
  const policy = {
    ...(s.policy === undefined ? {} : toPolicy(s.policy)),
    ...o.policy,
  };
  const input: ScenarioRunInput = {
    id: s.id,
    customerId: s.customerId,
    text: s.text,
    llm: buildLlmClient(s.llm),
    agentCore,
    ...(s.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: s.idempotencyKey }),
    ...(s.paymentMethodToken === undefined
      ? {}
      : { paymentMethodToken: s.paymentMethodToken }),
    ...(Object.keys(policy).length === 0 ? {} : { policy }),
    ...(s.steps === undefined ? {} : { steps: s.steps.map(toStep) }),
  };
  return runScenario(input);
}
