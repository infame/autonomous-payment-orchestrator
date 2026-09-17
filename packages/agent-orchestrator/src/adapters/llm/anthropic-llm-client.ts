import type Anthropic from "@anthropic-ai/sdk";
import type { ZodError, ZodType } from "zod";
import type { AgentProposal } from "../../domain/agent-proposal.js";
import {
  clarifyProposal,
  declineProposal,
  paymentProposal,
} from "../../domain/agent-proposal.js";
import { InvalidProposalError } from "../../domain/errors.js";
import type { LlmClient, LlmReasoningRequest } from "../../ports/llm-client.js";
import { LlmProtocolError } from "../../ports/llm-client.js";
import { mapAnthropicError } from "./anthropic-errors.js";
import { buildUserContent, SYSTEM_PROMPT } from "./anthropic-prompt.js";
import {
  ASK_CLARIFYING_QUESTION_TOOL,
  askClarifyingQuestionInputSchema,
  DECLINE_TOOL,
  declineInputSchema,
  PROPOSE_PAYMENT_TOOL,
  proposePaymentInputSchema,
  toolsFor,
} from "./anthropic-tools.js";

/**
 * The narrow surface `AnthropicLlmClient` actually needs from the SDK's
 * `client.messages` — never the whole `Anthropic` client. Letting a test
 * double implement exactly this interface (`FakeAnthropicMessages`,
 * `fake-anthropic-messages.ts`) is what keeps this adapter's own test suite
 * free of any real network call or API key.
 */
export interface AnthropicMessagesApi {
  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Messages.Message>;
}

export interface AnthropicLlmClientOptions {
  /** Injected, never an API key — see class header. */
  readonly messages: AnthropicMessagesApi;
  readonly model: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real, live `LlmClient` (spec step 7) — everywhere `MockLlmClient`
 * stands in during development, tests, and the demo's `mock` mode, this is
 * what a `live` mode would use instead. Not wired into anything by this step
 * (see `src/index.ts`'s header) — no composition root, no config, no
 * `LLM_MODE` switch exist yet.
 *
 * ## Three tools are response CHANNELS, not new capabilities
 *
 * `propose_payment` / `ask_clarifying_question` / `decline` are not three
 * different things the agent can now DO — they are the three possible
 * shapes of the one thing `reason()` has always been obligated to produce,
 * an `AgentProposal` (`domain/agent-proposal.ts`'s `propose_payment | clarify
 * | decline` union). Forcing the model to always answer via exactly one of
 * these three tool calls (`tool_choice: {type: "any",
 * disable_parallel_tool_use: true}`), rather than parsing free-form prose out
 * of a text response, means every way the model can fail to produce a valid
 * `AgentProposal` becomes a typed, caught `LlmProtocolError` instead of a
 * silent misparse: a missing field, a wrong type, two simultaneous tool
 * calls, an unrecognized tool name, or a stop reason that isn't `tool_use`
 * at all. If anything in this codebase's own spec/docs says "one tool" for
 * this step, read it as "one *decision*, offered through three tool
 * channels" — not a claim that a single JSON-schema tool is used.
 *
 * ## This class never re-checks grounding
 *
 * `anthropic-prompt.ts`'s system prompt spends real effort steering the
 * model toward proposing only amounts that literally appear in the source
 * text, but `reason()` itself never re-derives or filters on that. The
 * amount-grounding guarantee is `evaluatePolicy`'s `amountMustBeGrounded`
 * rule (`policy/rules.ts`) alone, applied uniformly to every `AgentProposal`
 * regardless of which `LlmClient` produced it. A domain-valid but
 * policy-hostile proposal — one that passes `paymentProposal()`'s structural
 * checks but proposes an amount the text never mentions — is expected to
 * flow through this adapter completely untouched. Two things depend on that:
 * the audit trail (what did the model actually say, unfiltered) and policy
 * testing parity (`MockLlmClient` and this class must present `evaluatePolicy`
 * with the same kind of unfiltered input).
 *
 * ## The API key never reaches this class
 *
 * `AnthropicLlmClientOptions.messages` is the narrow `AnthropicMessagesApi`
 * surface, never the full `Anthropic` client and never a credential.
 * `createAnthropicClient` (`anthropic-client.ts`) is the only place a real
 * API key is ever handled; nothing on `AnthropicLlmClient` itself — no
 * field, no method — ever holds or reads one.
 *
 * One caveat worth stating precisely: the installed SDK's own `Messages`
 * resource object carries an internal `_client` back-reference to its
 * owning `Anthropic` client (and therefore, transitively, that client's
 * `apiKey`) — an implementation detail of the vendor SDK, not something this
 * class controls. Passing `anthropicClient.messages` itself as `messages`
 * satisfies the `AnthropicMessagesApi` TYPE, but a caller that wants the
 * stronger runtime property — that nothing reachable from this instance's
 * object graph carries the key, e.g. because something downstream might
 * naively deep-`JSON.stringify` it for logging — should instead close over
 * the client in a plain object exposing only `create`, e.g. `{ create:
 * (params, options) => anthropicClient.messages.create(params, options) }`
 * (see `anthropic-llm-client.test.ts`'s credential tests). That composition
 * choice belongs to whatever constructs this class (the composition root,
 * step 8, not built yet), not to this file.
 *
 * ## One clarification round, enforced structurally
 *
 * `toolsFor(input.clarificationAnswer)` (`anthropic-tools.ts`) omits
 * `ask_clarifying_question` once `clarificationAnswer` is non-null — the
 * model is not merely told not to ask twice, it isn't offered the tool to do
 * so. See that file's header for the full rationale.
 *
 * ## Worst-case wall clock
 *
 * If the underlying `Anthropic` client (constructed via
 * `createAnthropicClient`) has a nonzero `maxRetries`, a single `reason()`
 * call can retry a timed-out or 5xx/429 request internally before this
 * class's own `catch` ever sees an error. Worst case, wall-clock time is
 * roughly `(maxRetries + 1) × timeoutMs` — e.g. the SDK's own default of 2
 * retries at this class's default 30s timeout is up to ~90s before a caller
 * sees `LlmUnavailableError`.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly name = "anthropic";

  constructor(private readonly options: AnthropicLlmClientOptions) {}

  async reason(input: LlmReasoningRequest): Promise<AgentProposal> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.options.model,
      max_tokens: this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserContent(input) }],
      tools: toolsFor(input.clarificationAnswer),
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    };

    let response: Anthropic.Messages.Message;
    try {
      response = await this.options.messages.create(params, {
        timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (response.stop_reason !== "tool_use") {
      throw new LlmProtocolError(
        `model did not call a tool (stop_reason: ${String(response.stop_reason)})`,
      );
    }

    const toolUseBlocks = response.content.filter(
      (contentBlock): contentBlock is Anthropic.Messages.ToolUseBlock =>
        contentBlock.type === "tool_use",
    );
    // Never silently take the first block on a multi-tool-use response — see
    // class header: two simultaneous tool calls is itself a protocol
    // failure (a sign of conflicting/injected instructions), not a
    // best-effort recovery opportunity.
    const [block, ...rest] = toolUseBlocks;
    if (block === undefined || rest.length > 0) {
      throw new LlmProtocolError(
        `expected exactly one tool_use block, got ${String(toolUseBlocks.length)}`,
      );
    }

    try {
      switch (block.name) {
        case PROPOSE_PAYMENT_TOOL:
          return paymentProposal(
            parseToolInput(proposePaymentInputSchema, block.input),
          );
        case ASK_CLARIFYING_QUESTION_TOOL:
          return clarifyProposal(
            parseToolInput(askClarifyingQuestionInputSchema, block.input)
              .question,
          );
        case DECLINE_TOOL:
          return declineProposal(
            parseToolInput(declineInputSchema, block.input).reason,
          );
        default:
          throw new LlmProtocolError(
            `model called an unrecognized tool: ${describeToolName(block.name)}`,
          );
      }
    } catch (err) {
      // No `cause` here, deliberately — same rule `anthropic-errors.ts`
      // applies to its `APIError` branches. `paymentProposal()`'s own error
      // message (domain/agent-proposal.ts) interpolates `input.currency`/
      // `input.merchantId` RAW, via `JSON.stringify`, precisely in the case
      // this branch exists to catch: when those fields are invalid. An
      // invalid value is exactly a model-controlled, unbounded string with
      // no format guarantee left — it could carry injected or customer
      // content the model stuffed into a `merchantId`/`currency` field.
      // Attaching `err` as `cause` would let that string ride along on the
      // cause chain even though this function's own message stays clean.
      if (err instanceof InvalidProposalError) {
        throw new LlmProtocolError(
          "model's tool call produced a structurally invalid proposal",
        );
      }
      throw err;
    }
  }
}

/**
 * A tool `name` on a `tool_use` block is model-controlled and, in an
 * unrecognized-tool case, unbounded — never echo it raw into an error
 * message. Gate it through a safe, bounded charset (matching this
 * codebase's own tool-name/id conventions) and fall back to a fixed,
 * content-free placeholder otherwise.
 */
function describeToolName(name: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "(unrecognizable name)";
}

/** Validates `input` against `schema`; on failure throws `LlmProtocolError` built ONLY from zod issue paths, never the raw invalid input. */
function parseToolInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new LlmProtocolError(describeZodIssues(result.error));
  }
  return result.data;
}

function describeZodIssues(error: ZodError): string {
  const paths = error.issues.map((issue) =>
    issue.path.length > 0 ? issue.path.join(".") : "(root)",
  );
  return `model's tool input failed validation at: ${paths.join(", ")}`;
}
