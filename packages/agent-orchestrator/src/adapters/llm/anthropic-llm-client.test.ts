import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  clarifyProposal,
  declineProposal,
  MAX_PROPOSAL_TEXT_LENGTH,
  paymentProposal,
} from "../../domain/agent-proposal.js";
import type { LlmClientError } from "../../ports/llm-client.js";
import {
  LlmConfigurationError,
  LlmProtocolError,
  LlmUnavailableError,
} from "../../ports/llm-client.js";
import { createAnthropicClient } from "./anthropic-client.js";
import { AnthropicLlmClient } from "./anthropic-llm-client.js";
import {
  ASK_CLARIFYING_QUESTION_TOOL,
  DECLINE_TOOL,
  PROPOSE_PAYMENT_TOOL,
} from "./anthropic-tools.js";
import {
  FakeAnthropicMessages,
  messageWithContent,
  textBlock,
  textMessage,
  toolUseBlock,
  toolUseMessage,
} from "./fake-anthropic-messages.js";

const MODEL = "claude-sonnet-5";
const CANARY_INTENT_TEXT = "canary-intent-please-do-not-leak-49217";
const CANARY_API_KEY = "sk-test-canary-should-never-leak-83214";

function request(
  intentText: string,
  clarificationAnswer: string | null = null,
): { intentText: string; clarificationAnswer: string | null } {
  return { intentText, clarificationAnswer };
}

function buildClient(
  responder: ConstructorParameters<typeof FakeAnthropicMessages>[0],
  overrides?: Partial<{ maxTokens: number; timeoutMs: number }>,
): { client: AnthropicLlmClient; fake: FakeAnthropicMessages } {
  const fake = new FakeAnthropicMessages(responder);
  const client = new AnthropicLlmClient({
    messages: fake,
    model: MODEL,
    ...overrides,
  });
  return { client, fake };
}

/**
 * `JSON.stringify` alone throws on the real SDK client's object graph (the
 * `Messages` resource holds a back-reference to its owning `Anthropic`
 * client, which is circular) — this is just a serialization limitation, not
 * evidence of anything to hide. A circular-safe stringify lets the "does the
 * API key appear anywhere in this object graph" assertion actually run.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        return "[circular]";
      }
      seen.add(val);
    }
    return val;
  });
}

/** Every tool this adapter offers is one of our own custom `Tool` definitions, never a server toolset — safe to narrow for assertions. */
function toolNames(
  tools: Anthropic.Messages.MessageCreateParamsNonStreaming["tools"],
): string[] {
  return ((tools ?? []) as Anthropic.Messages.Tool[]).map((tool) => tool.name);
}

function apiErrorWithCanary(
  status: number,
  type: string,
  requestId = "req_test_123",
): APIError {
  return APIError.generate(
    status,
    { error: { type, message: `should never leak: ${CANARY_INTENT_TEXT}` } },
    `should never leak either: ${CANARY_INTENT_TEXT}`,
    new Headers({ "request-id": requestId }),
  );
}

describe("AnthropicLlmClient — identity", () => {
  it("name is 'anthropic'", () => {
    const { client } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    expect(client.name).toBe("anthropic");
  });
});

describe("createAnthropicClient — credential validation", () => {
  it("throws LlmConfigurationError for a blank apiKey", () => {
    expect(() => createAnthropicClient({ apiKey: "" })).toThrow(
      LlmConfigurationError,
    );
  });

  it("throws LlmConfigurationError for a whitespace-only apiKey", () => {
    expect(() => createAnthropicClient({ apiKey: "   " })).toThrow(
      LlmConfigurationError,
    );
  });

  it("the error message names the field, never echoes a value", () => {
    expect.assertions(2);
    try {
      createAnthropicClient({ apiKey: "" });
    } catch (err) {
      expect(err).toBeInstanceOf(LlmConfigurationError);
      expect((err as Error).message).toContain("apiKey");
    }
  });

  it("returns a working client for a non-blank apiKey", () => {
    const anthropic = createAnthropicClient({ apiKey: "sk-test-something" });
    expect(anthropic).toBeDefined();
    expect(anthropic.messages).toBeDefined();
  });

  it("the API key string never appears in JSON.stringify of the constructed AnthropicLlmClient", () => {
    const anthropic = createAnthropicClient({ apiKey: CANARY_API_KEY });
    // Narrowed to exactly the AnthropicMessagesApi surface via a closure,
    // not `anthropic.messages` directly: the SDK's own `Messages` resource
    // carries an internal `_client` back-reference to its owning client
    // (and therefore, transitively, the API key) — an SDK implementation
    // detail this adapter has no control over. Closing over `anthropic`
    // inside a plain function, rather than storing the resource object
    // itself, is what actually keeps the key out of this class's own
    // object graph; see AnthropicLlmClient's header for the caveat.
    const client = new AnthropicLlmClient({
      messages: {
        create: (params, options) => anthropic.messages.create(params, options),
      },
      model: MODEL,
    });
    expect(safeStringify(client)).not.toContain(CANARY_API_KEY);
  });

  it("createAnthropicClient does not silently fall back to an ambient ANTHROPIC_API_KEY when apiKey is blank", () => {
    // The SDK's own constructor falls back to process.env.ANTHROPIC_API_KEY
    // when apiKey is omitted (undefined) — but never when it's an explicit
    // blank string. Stub a plausible-looking ambient credential and confirm
    // createAnthropicClient still rejects the blank apiKey rather than ever
    // reaching the SDK constructor at all.
    vi.stubEnv(
      "ANTHROPIC_API_KEY",
      "sk-ambient-host-credential-should-not-be-used",
    );
    try {
      expect(() => createAnthropicClient({ apiKey: "" })).toThrow(
        LlmConfigurationError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("AnthropicLlmClient — request assembly", () => {
  it("sends exactly one user message with intentText wrapped in <intent_text>", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice for 100.00"));
    const [call] = fake.calls;
    expect(call).toBeDefined();
    expect(call?.params.messages).toHaveLength(1);
    const [message] = call?.params.messages ?? [];
    expect(message?.role).toBe("user");
    expect(message?.content).toContain("<intent_text>");
    expect(message?.content).toContain("pay the invoice for 100.00");
  });

  it("system prompt is non-empty", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(typeof call?.params.system).toBe("string");
    expect((call?.params.system as string).length).toBeGreaterThan(0);
  });

  it("tools has exactly the 3 expected names when clarificationAnswer is null", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice", null));
    const [call] = fake.calls;
    const names = toolNames(call?.params.tools);
    expect(names.sort()).toEqual(
      [PROPOSE_PAYMENT_TOOL, ASK_CLARIFYING_QUESTION_TOOL, DECLINE_TOOL].sort(),
    );
  });

  it("tool_choice forces exactly one tool call", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(call?.params.tool_choice).toEqual({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });

  it("model/max_tokens reflect the constructor options", async () => {
    const { client, fake } = buildClient(
      () => toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
      { maxTokens: 2048 },
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(call?.params.model).toBe(MODEL);
    expect(call?.params.max_tokens).toBe(2048);
  });

  it("clarificationAnswer: null has no <clarification_answer> tag and includes ask_clarifying_question", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice", null));
    const [call] = fake.calls;
    const [message] = call?.params.messages ?? [];
    expect(message?.content).not.toContain("<clarification_answer>");
    const names = toolNames(call?.params.tools);
    expect(names).toContain(ASK_CLARIFYING_QUESTION_TOOL);
  });

  it("clarificationAnswer: 'some answer' has the tag present and omits ask_clarifying_question", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice", "some answer"));
    const [call] = fake.calls;
    const [message] = call?.params.messages ?? [];
    expect(message?.content).toContain("<clarification_answer>");
    expect(message?.content).toContain("some answer");
    const names = toolNames(call?.params.tools);
    expect(names).not.toContain(ASK_CLARIFYING_QUESTION_TOOL);
  });

  it("timeoutMs is forwarded as the create() options timeout field", async () => {
    const { client, fake } = buildClient(
      () => toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
      { timeoutMs: 12_345 },
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(call?.options?.timeout).toBe(12_345);
  });

  it("system prompt states the minor-units contract", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(call?.params.system).toContain("MINOR units");
  });

  it("system prompt states the minimum-candidate-amount rule", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(call?.params.system).toContain("SMALLEST candidate amount");
  });

  it("system prompt states the merchant-grounding rule", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request("pay the invoice"));
    const [call] = fake.calls;
    expect(call?.params.system).toContain("MERCHANT GROUNDING RULE");
  });
});

describe("AnthropicLlmClient — happy paths", () => {
  it("propose_payment resolves to the matching AgentProposal", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, {
        amount: 10_000,
        currency: "USD",
        merchantId: "demo_merchant",
        reasoning: "Verified against the invoice.",
      }),
    );
    const proposal = await client.reason(
      request("pay 100.00 to demo_merchant"),
    );
    expect(proposal).toEqual(
      paymentProposal({
        amount: 10_000,
        currency: "USD",
        merchantId: "demo_merchant",
        reasoning: "Verified against the invoice.",
      }),
    );
  });

  it("ask_clarifying_question resolves to a clarify proposal", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(ASK_CLARIFYING_QUESTION_TOOL, {
        question: "Which invoice amount did you mean?",
      }),
    );
    const proposal = await client.reason(request("pay either amount listed"));
    expect(proposal).toEqual(
      clarifyProposal("Which invoice amount did you mean?"),
    );
  });

  it("decline resolves to a decline proposal", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "Unsupported request." }),
    );
    const proposal = await client.reason(request("do something unsupported"));
    expect(proposal).toEqual(declineProposal("Unsupported request."));
  });

  it("a leading text block is ignored when a tool_use block also resolves", async () => {
    const { client } = buildClient(() =>
      messageWithContent(
        [
          textBlock("thinking out loud"),
          toolUseBlock(DECLINE_TOOL, { reason: "Unsupported request." }),
        ],
        "tool_use",
      ),
    );
    const proposal = await client.reason(request("do something unsupported"));
    expect(proposal).toEqual(declineProposal("Unsupported request."));
  });
});

describe("AnthropicLlmClient — protocol failures", () => {
  it("throws LlmProtocolError, non-retryable, for stop_reason 'end_turn' with no tool call", async () => {
    const { client } = buildClient(() =>
      textMessage("I decline to answer.", "end_turn"),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
    try {
      await client.reason(request("pay something"));
      expect.unreachable();
    } catch (err) {
      expect((err as LlmClientError).retryable).toBe(false);
    }
  });

  it("throws LlmProtocolError for stop_reason 'max_tokens' (truncated tool call)", async () => {
    const { client } = buildClient(() =>
      textMessage("partial output", "max_tokens"),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });

  it("throws LlmProtocolError for two tool_use blocks, never resolving the first tool's proposal", async () => {
    const { client } = buildClient(() =>
      messageWithContent(
        [
          toolUseBlock(PROPOSE_PAYMENT_TOOL, {
            amount: 10_000,
            currency: "USD",
            merchantId: "demo_merchant",
            reasoning: "first",
          }),
          toolUseBlock(DECLINE_TOOL, { reason: "second" }),
        ],
        "tool_use",
      ),
    );
    let caught: unknown;
    try {
      await client.reason(request("pay something"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProtocolError);
    expect(caught).not.toEqual(
      paymentProposal({
        amount: 10_000,
        currency: "USD",
        merchantId: "demo_merchant",
        reasoning: "first",
      }),
    );
  });

  it("throws LlmProtocolError for an unrecognized tool name", async () => {
    const { client } = buildClient(() =>
      toolUseMessage("delete_all_payments", { yolo: true }),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });

  it("throws LlmProtocolError when tool input is not an object (string)", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, "not an object"),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });

  it("throws LlmProtocolError when tool input is null", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, null),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });

  it("throws LlmProtocolError when propose_payment is missing currency", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, {
        amount: 10_000,
        merchantId: "demo_merchant",
        reasoning: "n/a",
      }),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });

  it("throws LlmProtocolError when amount is a string, never silently coerced", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, {
        amount: "10000",
        currency: "USD",
        merchantId: "demo_merchant",
        reasoning: "n/a",
      }),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });

  it.each([0, -1, 10.5])(
    "throws LlmProtocolError when amount is %s",
    async (amount) => {
      const { client } = buildClient(() =>
        toolUseMessage(PROPOSE_PAYMENT_TOOL, {
          amount,
          currency: "USD",
          merchantId: "demo_merchant",
          reasoning: "n/a",
        }),
      );
      await expect(client.reason(request("pay something"))).rejects.toThrow(
        LlmProtocolError,
      );
    },
  );

  it("throws LlmProtocolError (never InvalidProposalError) for an invalid currency", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, {
        amount: 10_000,
        currency: "usd",
        merchantId: "demo_merchant",
        reasoning: "n/a",
      }),
    );
    let caught: unknown;
    try {
      await client.reason(request("pay something"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProtocolError);
    expect((caught as Error).name).not.toBe("InvalidProposalError");
  });

  it("throws LlmProtocolError (never InvalidProposalError) for an invalid merchantId", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, {
        amount: 10_000,
        currency: "USD",
        merchantId: "has a space",
        reasoning: "n/a",
      }),
    );
    let caught: unknown;
    try {
      await client.reason(request("pay something"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmProtocolError);
    expect((caught as Error).name).not.toBe("InvalidProposalError");
  });

  it("throws LlmProtocolError for a blank/whitespace-only clarifying question", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(ASK_CLARIFYING_QUESTION_TOOL, { question: "   " }),
    );
    await expect(
      client.reason(request("pay either amount", null)),
    ).rejects.toThrow(LlmProtocolError);
  });

  it("throws LlmProtocolError when reasoning exceeds the domain's max length", async () => {
    const { client } = buildClient(() =>
      toolUseMessage(PROPOSE_PAYMENT_TOOL, {
        amount: 10_000,
        currency: "USD",
        merchantId: "demo_merchant",
        reasoning: "x".repeat(MAX_PROPOSAL_TEXT_LENGTH + 1),
      }),
    );
    await expect(client.reason(request("pay something"))).rejects.toThrow(
      LlmProtocolError,
    );
  });
});

describe("AnthropicLlmClient — transport failures", () => {
  it("a timeout-shaped SDK error maps to LlmUnavailableError mentioning timing out", async () => {
    const { client } = buildClient(() => {
      throw new APIConnectionTimeoutError();
    });
    let caught: unknown;
    try {
      await client.reason(request("pay something"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmUnavailableError);
    expect((caught as LlmClientError).retryable).toBe(true);
    expect((caught as Error).message.toLowerCase()).toContain("timed out");
  });

  it("a connection-error-shaped SDK error maps to LlmUnavailableError", async () => {
    const { client } = buildClient(() => {
      throw new APIConnectionError({ message: "ECONNREFUSED" });
    });
    let caught: unknown;
    try {
      await client.reason(request("pay something"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmUnavailableError);
    expect((caught as LlmClientError).retryable).toBe(true);
  });

  it("an aborted request maps to LlmUnavailableError", async () => {
    const { client } = buildClient(() => {
      throw new APIUserAbortError();
    });
    await expect(
      client.reason(request("pay something")),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("a 429 status maps to LlmUnavailableError", async () => {
    const { client } = buildClient(() => {
      throw apiErrorWithCanary(429, "rate_limit_error");
    });
    await expect(
      client.reason(request("pay something")),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it.each([500, 529])(
    "a %s status maps to LlmUnavailableError",
    async (status) => {
      const { client } = buildClient(() => {
        throw apiErrorWithCanary(status, "api_error");
      });
      await expect(
        client.reason(request("pay something")),
      ).rejects.toBeInstanceOf(LlmUnavailableError);
    },
  );

  it("a non-Error thrown value never escapes as a raw string/unknown value", async () => {
    const { client } = buildClient(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately simulating a non-Error throw from the SDK/fetch layer
      throw "boom";
    });
    let caught: unknown;
    try {
      await client.reason(request("pay something"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmUnavailableError);
  });
});

describe("AnthropicLlmClient — configuration failures", () => {
  it.each([401, 403, 400])(
    "a %s status maps to LlmConfigurationError",
    async (status) => {
      const { client } = buildClient(() => {
        throw apiErrorWithCanary(status, "invalid_request_error");
      });
      let caught: unknown;
      try {
        await client.reason(request("pay something"));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LlmConfigurationError);
      expect((caught as LlmClientError).retryable).toBe(false);
    },
  );
});

describe("AnthropicLlmClient — no secret/content leakage across every failure scenario", () => {
  const forbidden = [CANARY_API_KEY, CANARY_INTENT_TEXT];

  function assertNoLeak(err: unknown): void {
    let current: unknown = err;
    const seen = new Set<unknown>();
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      for (const value of forbidden) {
        expect(current.message).not.toContain(value);
      }
      current = (current as { cause?: unknown }).cause;
    }
  }

  const scenarios: Array<{
    name: string;
    trigger: ConstructorParameters<typeof FakeAnthropicMessages>[0];
  }> = [
    {
      name: "timeout",
      trigger: () => {
        throw new APIConnectionTimeoutError();
      },
    },
    {
      // A real APIConnectionError's message describes a local network
      // failure (DNS/socket) — never echoed request content — so unlike the
      // APIError-status scenarios below, this one does NOT embed the canary
      // in the thrown error itself. `mapAnthropicError` DOES attach `cause`
      // for this branch (see its header); the assertion below still holds
      // because the underlying error never carries customer content.
      name: "connection error",
      trigger: () => {
        throw new APIConnectionError({ message: "ECONNREFUSED" });
      },
    },
    {
      name: "429",
      trigger: () => {
        throw apiErrorWithCanary(429, "rate_limit_error");
      },
    },
    {
      name: "500",
      trigger: () => {
        throw apiErrorWithCanary(500, "api_error");
      },
    },
    {
      name: "401",
      trigger: () => {
        throw apiErrorWithCanary(401, "authentication_error");
      },
    },
    {
      name: "403",
      trigger: () => {
        throw apiErrorWithCanary(403, "permission_error");
      },
    },
    {
      name: "400",
      trigger: () => {
        throw apiErrorWithCanary(400, "invalid_request_error");
      },
    },
    {
      // Not an SDK-thrown error at all — the vendor call succeeds, but the
      // model stuffed the canary into merchantId, which fails
      // paymentProposal()'s own MERCHANT_ID regex. This is the scenario the
      // InvalidProposalError -> LlmProtocolError rewrap in
      // anthropic-llm-client.ts must not leak through: that rewrap
      // deliberately drops `cause` for exactly this reason.
      name: "invalid merchantId (InvalidProposalError rewrap)",
      trigger: () =>
        toolUseMessage(PROPOSE_PAYMENT_TOOL, {
          amount: 10_000,
          currency: "USD",
          merchantId: `pay ${CANARY_INTENT_TEXT} to acme`,
          reasoning: "n/a",
        }),
    },
  ];

  it.each(scenarios)(
    "$name never leaks the API key or intent text",
    async ({ trigger }) => {
      const { client, fake } = buildClient(trigger);
      let caught: unknown;
      try {
        await client.reason(request(`please pay ${CANARY_INTENT_TEXT}`));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      assertNoLeak(caught);
      for (const call of fake.calls) {
        expect(JSON.stringify(call.params)).not.toContain(CANARY_API_KEY);
        expect(JSON.stringify(call.options)).not.toContain(CANARY_API_KEY);
      }
    },
  );

  it("the fake's recorded calls never contain the API key for a successful call either", async () => {
    const { client, fake } = buildClient(() =>
      toolUseMessage(DECLINE_TOOL, { reason: "n/a" }),
    );
    await client.reason(request(`please pay ${CANARY_INTENT_TEXT}`));
    for (const call of fake.calls) {
      expect(JSON.stringify(call.params)).not.toContain(CANARY_API_KEY);
      expect(JSON.stringify(call.options)).not.toContain(CANARY_API_KEY);
    }
  });
});
