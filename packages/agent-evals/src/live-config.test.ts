/**
 * No test in this file reads a real ANTHROPIC_API_KEY: every key value below
 * is a synthetic, obviously-fake test string, and `loadLiveConfig` never
 * makes a network call — it only parses `process.env`-shaped objects.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadLiveConfig } from "./live-config.js";

const KEY = "sk-test-fake-not-real-59217";

describe("loadLiveConfig", () => {
  it("throws ConfigError naming ANTHROPIC_API_KEY when it is absent", () => {
    try {
      loadLiveConfig({});
      throw new Error("expected loadLiveConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("rejects a blank ANTHROPIC_API_KEY", () => {
    try {
      loadLiveConfig({ ANTHROPIC_API_KEY: "   " });
      throw new Error("expected loadLiveConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("never echoes the key's own value in a ConfigError message (canary)", () => {
    // A bad MAX_LIVE_CALLS forces the schema to still fail even with a
    // present, valid-shaped key — proving the redaction discipline holds
    // beyond just the "key missing" case.
    try {
      loadLiveConfig({ ANTHROPIC_API_KEY: KEY, MAX_LIVE_CALLS: "-1" });
      throw new Error("expected loadLiveConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).not.toContain(KEY);
    }
  });

  it("applies documented defaults", () => {
    const cfg = loadLiveConfig({ ANTHROPIC_API_KEY: KEY });
    expect(cfg.ANTHROPIC_API_KEY).toBe(KEY);
    expect(cfg.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(cfg.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(cfg.ANTHROPIC_MAX_RETRIES).toBeUndefined();
    expect(cfg.LLM_TIMEOUT_MS).toBe(30_000);
    expect(cfg.MAX_LIVE_CALLS).toBe(100);
    expect(cfg.EVAL_LIVE_K).toBe(1);
  });

  it("rejects a non-URL ANTHROPIC_BASE_URL", () => {
    expect(() =>
      loadLiveConfig({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "nope" }),
    ).toThrow(ConfigError);
  });

  it("ANTHROPIC_MAX_RETRIES='' falls back to unset, not 0", () => {
    const cfg = loadLiveConfig({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_MAX_RETRIES: "",
    });
    expect(cfg.ANTHROPIC_MAX_RETRIES).toBeUndefined();
  });

  it("ANTHROPIC_MAX_RETRIES='0' is honoured as an explicit zero", () => {
    const cfg = loadLiveConfig({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_MAX_RETRIES: "0",
    });
    expect(cfg.ANTHROPIC_MAX_RETRIES).toBe(0);
  });

  it.each(["MAX_LIVE_CALLS", "EVAL_LIVE_K"] as const)(
    "%s='' fails loudly via .positive(), rather than silently becoming 0",
    (field) => {
      expect(() =>
        loadLiveConfig({ ANTHROPIC_API_KEY: KEY, [field]: "" }),
      ).toThrow(ConfigError);
    },
  );

  it.each(["MAX_LIVE_CALLS", "EVAL_LIVE_K"] as const)(
    "%s rejects a negative value",
    (field) => {
      expect(() =>
        loadLiveConfig({ ANTHROPIC_API_KEY: KEY, [field]: "-5" }),
      ).toThrow(ConfigError);
    },
  );

  it("a non-numeric MAX_LIVE_CALLS aborts before superRefine, so it does not co-report a missing key", () => {
    try {
      loadLiveConfig({ MAX_LIVE_CALLS: "not-a-number" });
      throw new Error("expected loadLiveConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain("MAX_LIVE_CALLS");
      expect(message).not.toContain("ANTHROPIC_API_KEY");
    }
  });
});
