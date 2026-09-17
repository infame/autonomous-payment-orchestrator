import Anthropic from "@anthropic-ai/sdk";
import { LlmConfigurationError } from "../../ports/llm-client.js";

/**
 * The one place this package constructs a real `Anthropic` SDK client. Kept
 * separate from `AnthropicLlmClient` (`anthropic-llm-client.ts`) because that
 * class only ever holds the narrow `AnthropicMessagesApi` surface, never a
 * credential — see its own header for why.
 *
 * ## The silent ambient-credential fallback this guard closes
 *
 * Per the installed SDK's own `ClientOptions.apiKey` doc comment
 * (`node_modules/@anthropic-ai/sdk/client.d.ts`): when `apiKey` is omitted
 * (`undefined`) — and no `authToken`/`credentials`/`config`/`profile` is
 * supplied either — the client "automatically resolves credentials from
 * config files or environment variables on the first request"
 * (`process.env['ANTHROPIC_API_KEY']`, then a config-file/profile chain).
 * That means an under-configured deployment — one that forgot to plumb an
 * `apiKey` through at all — doesn't fail loudly; it silently authenticates
 * as whatever credential happens to be sitting on the host machine, which in
 * a shared CI runner or a developer's laptop is very possibly *not* the
 * credential this deployment is supposed to use. Passing an explicit blank
 * string (`""`) does NOT trigger that fallback — a static string is used
 * as-is, so a blank `apiKey` just authenticates as `""` and fails with a 401
 * on the first real request instead, which is a much later and noisier
 * failure than this package wants. `createAnthropicClient` closes both
 * paths: `apiKey` is a required, non-optional field on
 * `AnthropicClientOptions`, and this function additionally rejects a
 * blank/whitespace-only value before ever constructing the SDK client —
 * turning either failure mode into an immediate, loud
 * `LlmConfigurationError` instead of a silent wrong-credential resolution or
 * a delayed 401.
 */
export interface AnthropicClientOptions {
  /** Required, must be non-blank — validated here before the SDK ever sees it. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** SDK-level retry count for 408/409/429/5xx. Defaults to the SDK's own default (2) when omitted. */
  readonly maxRetries?: number;
}

export function createAnthropicClient(
  options: AnthropicClientOptions,
): Anthropic {
  if (options.apiKey.trim() === "") {
    throw new LlmConfigurationError("apiKey must not be blank");
  }
  return new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: options.maxRetries,
  });
}
