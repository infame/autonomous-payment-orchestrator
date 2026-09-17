import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicMessagesApi } from "./anthropic-llm-client.js";

/**
 * Test support only — deliberately NOT exported from `src/index.ts` (see its
 * header), same convention as `adapters/http/fake-durable-ledger-server.ts`.
 *
 * Unlike that file, this one does NOT stand up a real socket. The risky code
 * in `AnthropicLlmClient` is prompt/tool assembly and response parsing, not
 * HTTP/timeout plumbing — `AnthropicMessagesApi` (`anthropic-llm-client.ts`)
 * is already a narrow, single-method interface the SDK's own `client.messages`
 * satisfies structurally, so a plain in-process test double over that
 * interface exercises exactly the part of this adapter worth testing, with
 * zero network flakiness and no timeout/`AbortSignal` plumbing of its own to
 * get subtly wrong. See `README.md`'s "Considered and rejected" section for
 * the fuller comparison against ADR-0006's real-socket approach.
 *
 * `Message`/`Usage`/`ToolUseBlock` all carry several required fields on the
 * installed SDK version (`@anthropic-ai/sdk` 0.126.0) that have nothing to do
 * with what any test here actually varies — `container`, `stop_details`,
 * `cache_creation`, `service_tier`, `caller`, etc. Building fixtures via the
 * helpers below, once, keeps every test call site oblivious to those fields
 * entirely.
 */

type Responder = (
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
) => Anthropic.Messages.Message | Promise<Anthropic.Messages.Message>;

export interface RecordedCreateCall {
  readonly params: Anthropic.Messages.MessageCreateParamsNonStreaming;
  readonly options: Anthropic.RequestOptions | undefined;
}

/**
 * A test double for `AnthropicMessagesApi`. `responder` computes the
 * response (or throws, synchronously, to script a transport/vendor
 * failure) — `create()` itself does no try/catch, so a synchronous throw
 * from `responder` propagates out of `create()` exactly like the real SDK's
 * `messages.create` rejecting would, letting `AnthropicLlmClient.reason()`'s
 * own `try`/`catch` around the `create()` call handle both shapes uniformly.
 */
export class FakeAnthropicMessages implements AnthropicMessagesApi {
  readonly calls: RecordedCreateCall[] = [];

  constructor(private readonly responder: Responder) {}

  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Messages.Message> {
    this.calls.push({ params, options });
    return Promise.resolve(this.responder(params));
  }
}

let fixtureCounter = 0;

function nextId(prefix: string): string {
  fixtureCounter += 1;
  return `${prefix}_fake_${String(fixtureCounter)}`;
}

const FIXTURE_MODEL = "claude-sonnet-5";

const FIXTURE_USAGE: Anthropic.Messages.Usage = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
};

/** A complete, valid `ToolUseBlock` with a fresh id each call. */
export function toolUseBlock(
  name: string,
  input: unknown,
): Anthropic.Messages.ToolUseBlock {
  return {
    type: "tool_use",
    id: nextId("toolu"),
    name,
    input,
    caller: { type: "direct" },
  };
}

/** A complete, valid `TextBlock`. */
export function textBlock(text: string): Anthropic.Messages.TextBlock {
  return { type: "text", text, citations: null };
}

/**
 * A complete, valid `Message` fixture wrapping the given content blocks —
 * every required `Message`/`Usage` field the installed SDK type demands,
 * filled with a fixed, inert value. `toolUseMessage`/`textMessage` below
 * cover the common single-block cases; use this directly to build the
 * multi-block scenarios (two `tool_use` blocks, or a leading `text` block
 * followed by a `tool_use` block) `anthropic-llm-client.test.ts` needs.
 */
export function messageWithContent(
  content: Anthropic.Messages.ContentBlock[],
  stopReason: Anthropic.Messages.StopReason = "tool_use",
): Anthropic.Messages.Message {
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model: FIXTURE_MODEL,
    container: null,
    stop_sequence: null,
    stop_details: null,
    stop_reason: stopReason,
    content,
    usage: FIXTURE_USAGE,
  };
}

/** A `Message` with exactly one `tool_use` block and `stop_reason: "tool_use"`. */
export function toolUseMessage(
  name: string,
  input: unknown,
): Anthropic.Messages.Message {
  return messageWithContent([toolUseBlock(name, input)], "tool_use");
}

/** A `Message` with exactly one `text` block and the given (or default `end_turn`) `stop_reason`. */
export function textMessage(
  text: string,
  stopReason: Anthropic.Messages.StopReason = "end_turn",
): Anthropic.Messages.Message {
  return messageWithContent([textBlock(text)], stopReason);
}
