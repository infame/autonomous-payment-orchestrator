import { describe, expect, it } from "vitest";
import { OrchestratorError } from "../domain/errors.js";
import {
  LlmClientError,
  LlmProtocolError,
  LlmUnavailableError,
} from "./llm-client.js";

describe("LlmUnavailableError", () => {
  it("is an instanceof LlmClientError and Error", () => {
    const err = new LlmUnavailableError("timeout");
    expect(err).toBeInstanceOf(LlmClientError);
    expect(err).toBeInstanceOf(Error);
  });

  it("is not an instanceof LlmProtocolError", () => {
    const err = new LlmUnavailableError("timeout");
    expect(err).not.toBeInstanceOf(LlmProtocolError);
  });

  it("retryable is true", () => {
    expect(new LlmUnavailableError("timeout").retryable).toBe(true);
  });

  it("code is the stable literal", () => {
    expect(new LlmUnavailableError("timeout").code).toBe("llm_unavailable");
  });

  it("name reflects the concrete subclass", () => {
    expect(new LlmUnavailableError("timeout").name).toBe("LlmUnavailableError");
  });

  it("threads cause through when supplied", () => {
    const cause = new Error("network reset");
    const err = new LlmUnavailableError("timeout", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is absent when not supplied", () => {
    const err = new LlmUnavailableError("timeout");
    expect(err.cause).toBeUndefined();
  });

  it("carries its own reason field", () => {
    expect(new LlmUnavailableError("rate limited").reason).toBe("rate limited");
  });

  it("is not an OrchestratorError", () => {
    expect(new LlmUnavailableError("timeout")).not.toBeInstanceOf(
      OrchestratorError,
    );
  });
});

describe("LlmProtocolError", () => {
  it("is an instanceof LlmClientError and Error", () => {
    const err = new LlmProtocolError("unparseable response");
    expect(err).toBeInstanceOf(LlmClientError);
    expect(err).toBeInstanceOf(Error);
  });

  it("is not an instanceof LlmUnavailableError", () => {
    const err = new LlmProtocolError("unparseable response");
    expect(err).not.toBeInstanceOf(LlmUnavailableError);
  });

  it("retryable is false", () => {
    expect(new LlmProtocolError("unparseable response").retryable).toBe(false);
  });

  it("code is the stable literal", () => {
    expect(new LlmProtocolError("unparseable response").code).toBe(
      "llm_protocol_error",
    );
  });

  it("name reflects the concrete subclass", () => {
    expect(new LlmProtocolError("unparseable response").name).toBe(
      "LlmProtocolError",
    );
  });

  it("threads cause through when supplied", () => {
    const cause = new SyntaxError("unexpected token");
    const err = new LlmProtocolError("unparseable response", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is absent when not supplied", () => {
    const err = new LlmProtocolError("unparseable response");
    expect(err.cause).toBeUndefined();
  });

  it("is not an OrchestratorError", () => {
    expect(new LlmProtocolError("unparseable response")).not.toBeInstanceOf(
      OrchestratorError,
    );
  });
});

describe("LlmUnavailableError and LlmProtocolError are mutually exclusive", () => {
  it("neither is an instance of the other", () => {
    const unavailable = new LlmUnavailableError("timeout");
    const protocol = new LlmProtocolError("bad response");
    expect(unavailable).not.toBeInstanceOf(LlmProtocolError);
    expect(protocol).not.toBeInstanceOf(LlmUnavailableError);
  });

  it("both are LlmClientError but the base class is abstract (never constructed directly)", () => {
    expect(new LlmUnavailableError("timeout")).toBeInstanceOf(LlmClientError);
    expect(new LlmProtocolError("bad response")).toBeInstanceOf(LlmClientError);
  });
});
