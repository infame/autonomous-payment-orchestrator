import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://apo:apo@localhost:5433/apo",
  DURABLE_LEDGER_URL: "http://localhost:3100",
  PAYMENT_METHOD_TOKEN: "pm_demo_token",
};

describe("loadConfig", () => {
  it("applies documented defaults when only the required vars are set", () => {
    const cfg = loadConfig(BASE_ENV);

    expect(cfg.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(cfg.DURABLE_LEDGER_URL).toBe(BASE_ENV.DURABLE_LEDGER_URL);
    expect(cfg.PAYMENT_METHOD_TOKEN).toBe(BASE_ENV.PAYMENT_METHOD_TOKEN);
    expect(cfg.PORT).toBe(3200);
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.LLM_MODE).toBe("mock");
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(cfg.ANTHROPIC_MAX_RETRIES).toBeUndefined();
    expect(cfg.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(cfg.LLM_TIMEOUT_MS).toBe(30_000);
    expect(cfg.DURABLE_LEDGER_TIMEOUT_MS).toBe(10_000);
    expect(cfg.POLICY_ALLOWED_CURRENCIES).toEqual(["USD", "EUR", "GBP"]);
    expect(cfg.POLICY_MAX_AUTO_APPROVE_AMOUNT).toBe(50_000);
    expect(cfg.POLICY_MAX_HARD_LIMIT_AMOUNT).toBe(500_000);
    expect(cfg.POLICY_DAILY_RATE_LIMIT).toBe(10);
    expect(cfg.MIGRATE_ON_BOOT).toBe(true);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it("throws a ConfigError naming all 3 missing required vars in one message", () => {
    try {
      loadConfig({});
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("DURABLE_LEDGER_URL");
      expect(message).toContain("PAYMENT_METHOD_TOKEN");
    }
  });

  it("rejects a non-URL DURABLE_LEDGER_URL", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DURABLE_LEDGER_URL: "not-a-url" }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-URL ANTHROPIC_BASE_URL", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, ANTHROPIC_BASE_URL: "not-a-url" }),
    ).toThrow(ConfigError);
  });

  it("rejects a whitespace-only PAYMENT_METHOD_TOKEN (passes .min(1), fails the blank refine)", () => {
    try {
      loadConfig({ ...BASE_ENV, PAYMENT_METHOD_TOKEN: "   " });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("PAYMENT_METHOD_TOKEN");
    }
  });

  // Spec §12's DoD: the service refuses to boot in live mode without an API key.
  it("throws naming ANTHROPIC_API_KEY when LLM_MODE=live without one", () => {
    try {
      loadConfig({ ...BASE_ENV, LLM_MODE: "live" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("does not require ANTHROPIC_API_KEY when LLM_MODE is left at its default (mock)", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.LLM_MODE).toBe("mock");
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("accepts LLM_MODE=live when an ANTHROPIC_API_KEY is set, and passes the key through", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      LLM_MODE: "live",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
    });
    expect(cfg.LLM_MODE).toBe("live");
    expect(cfg.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
  });

  it("rejects an unrecognized LLM_MODE", () => {
    expect(() => loadConfig({ ...BASE_ENV, LLM_MODE: "hybrid" })).toThrow(
      ConfigError,
    );
  });

  // The single most important test in this file: superRefine's whole point
  // is that independent cross-field issues surface TOGETHER in one throw,
  // not one-at-a-time across repeated loadConfig calls.
  it("surfaces both cross-field superRefine issues in a single ConfigError", () => {
    try {
      loadConfig({
        ...BASE_ENV,
        LLM_MODE: "live",
        POLICY_MAX_AUTO_APPROVE_AMOUNT: "500000",
        POLICY_MAX_HARD_LIMIT_AMOUNT: "50000",
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain("ANTHROPIC_API_KEY");
      expect(message).toContain("POLICY_MAX_HARD_LIMIT_AMOUNT");
      // Exactly 3: the "Invalid configuration:" header line plus one line
      // per issue. `>= 2` would also pass with only ONE issue surfaced
      // (header + 1), which defeats the point of this test.
      expect(message.split("\n").length).toBe(3);
    }
  });

  it("does not throw when POLICY_MAX_HARD_LIMIT_AMOUNT equals POLICY_MAX_AUTO_APPROVE_AMOUNT (pins strict < , not <=)", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      POLICY_MAX_AUTO_APPROVE_AMOUNT: "100000",
      POLICY_MAX_HARD_LIMIT_AMOUNT: "100000",
    });
    expect(cfg.POLICY_MAX_AUTO_APPROVE_AMOUNT).toBe(100_000);
    expect(cfg.POLICY_MAX_HARD_LIMIT_AMOUNT).toBe(100_000);
  });

  it("tolerates whitespace and a trailing comma in POLICY_ALLOWED_CURRENCIES", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      POLICY_ALLOWED_CURRENCIES: "USD, EUR,",
    });
    expect(cfg.POLICY_ALLOWED_CURRENCIES).toEqual(["USD", "EUR"]);
  });

  it("rejects a lowercase currency code", () => {
    try {
      loadConfig({ ...BASE_ENV, POLICY_ALLOWED_CURRENCIES: "usd,EUR" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(
        "POLICY_ALLOWED_CURRENCIES",
      );
    }
  });

  it("rejects a non-alpha-3 currency code", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, POLICY_ALLOWED_CURRENCIES: "EURO" }),
    ).toThrow(ConfigError);
  });

  it("rejects an empty POLICY_ALLOWED_CURRENCIES list", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, POLICY_ALLOWED_CURRENCIES: "" }),
    ).toThrow(ConfigError);
  });

  it("rejects a bare comma (an empty list after filtering)", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, POLICY_ALLOWED_CURRENCIES: "," }),
    ).toThrow(ConfigError);
  });

  it("rejects duplicate currency codes", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, POLICY_ALLOWED_CURRENCIES: "USD,USD" }),
    ).toThrow(ConfigError);
  });

  it("coerces numeric env vars", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      PORT: "4000",
      LLM_TIMEOUT_MS: "5000",
      DURABLE_LEDGER_TIMEOUT_MS: "6000",
      SHUTDOWN_TIMEOUT_MS: "2000",
      POLICY_MAX_AUTO_APPROVE_AMOUNT: "1000",
      POLICY_MAX_HARD_LIMIT_AMOUNT: "2000",
      POLICY_DAILY_RATE_LIMIT: "5",
      ANTHROPIC_MAX_RETRIES: "0",
    });
    expect(cfg.PORT).toBe(4000);
    expect(cfg.LLM_TIMEOUT_MS).toBe(5000);
    expect(cfg.DURABLE_LEDGER_TIMEOUT_MS).toBe(6000);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(2000);
    expect(cfg.POLICY_MAX_AUTO_APPROVE_AMOUNT).toBe(1000);
    expect(cfg.POLICY_MAX_HARD_LIMIT_AMOUNT).toBe(2000);
    expect(cfg.POLICY_DAILY_RATE_LIMIT).toBe(5);
    // 0 is allowed here (.min(0), not .positive()) — the SDK's own retry knob.
    expect(cfg.ANTHROPIC_MAX_RETRIES).toBe(0);
  });

  // Pins the FOO=""->0 trap: an env var set but left empty must never be
  // silently treated as a deliberate value. This must never be "fixed" to
  // .min(0) to match resolvePolicyConfig's own looser 0-allowing check — the
  // 0 kill-switch stays reachable only through the programmatic
  // resolvePolicyConfig API, not through this env var.
  it("rejects POLICY_DAILY_RATE_LIMIT set to an empty string rather than silently coercing it to 0", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, POLICY_DAILY_RATE_LIMIT: "" }),
    ).toThrow(ConfigError);
  });

  // Same FOO=""->0 trap, different fix: 0 is a legal, meaningfully different
  // value for ANTHROPIC_MAX_RETRIES (explicitly "no SDK retries"), so unlike
  // POLICY_DAILY_RATE_LIMIT this field can't just reject "". Instead an empty
  // string must fall back to "unset" (the SDK's own default), never become
  // an explicit, silent 0.
  it("treats ANTHROPIC_MAX_RETRIES set to an empty string as unset, not 0", () => {
    const cfg = loadConfig({ ...BASE_ENV, ANTHROPIC_MAX_RETRIES: "" });
    expect(cfg.ANTHROPIC_MAX_RETRIES).toBeUndefined();
  });

  it("rejects PORT outside the 1..65535 range", () => {
    expect(() => loadConfig({ ...BASE_ENV, PORT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, PORT: "70000" })).toThrow(
      ConfigError,
    );
  });

  it("transforms MIGRATE_ON_BOOT=false to a boolean false, and defaults to true", () => {
    expect(
      loadConfig({ ...BASE_ENV, MIGRATE_ON_BOOT: "false" }).MIGRATE_ON_BOOT,
    ).toBe(false);
    expect(loadConfig(BASE_ENV).MIGRATE_ON_BOOT).toBe(true);
  });

  it("rejects a MIGRATE_ON_BOOT value other than true/false", () => {
    expect(() => loadConfig({ ...BASE_ENV, MIGRATE_ON_BOOT: "1" })).toThrow(
      ConfigError,
    );
  });

  it("never leaks a supplied secret/URL value into the ConfigError message", () => {
    const secretDbUrl = "postgres://apo:s3cr3t-pw@localhost:5433/apo";
    const secretApiKey = "sk-ant-super-secret-value-12345";
    const secretToken = "pm_super_secret_token_67890";
    try {
      loadConfig({
        DATABASE_URL: secretDbUrl,
        DURABLE_LEDGER_URL: "not-a-url",
        PAYMENT_METHOD_TOKEN: secretToken,
        LLM_MODE: "live",
        ANTHROPIC_API_KEY: secretApiKey,
      });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).not.toContain(secretDbUrl);
      expect(message).not.toContain(secretApiKey);
      expect(message).not.toContain(secretToken);
      expect(message).not.toContain("not-a-url");
      expect(message).toContain("DURABLE_LEDGER_URL");
    }
  });

  it("defaults to process.env when no env argument is passed", () => {
    const previous = { ...process.env };
    process.env.DATABASE_URL = BASE_ENV.DATABASE_URL;
    process.env.DURABLE_LEDGER_URL = BASE_ENV.DURABLE_LEDGER_URL;
    process.env.PAYMENT_METHOD_TOKEN = BASE_ENV.PAYMENT_METHOD_TOKEN;
    try {
      const cfg = loadConfig();
      expect(cfg.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
      expect(cfg.DURABLE_LEDGER_URL).toBe(BASE_ENV.DURABLE_LEDGER_URL);
      expect(cfg.PAYMENT_METHOD_TOKEN).toBe(BASE_ENV.PAYMENT_METHOD_TOKEN);
    } finally {
      for (const key of [
        "DATABASE_URL",
        "DURABLE_LEDGER_URL",
        "PAYMENT_METHOD_TOKEN",
      ]) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });
});

describe("HTTPS env URL boundary", () => {
  it("accepts HTTPS", () => {
    expect(
      loadConfig({
        ...BASE_ENV,
        ANTHROPIC_API_KEY: "fake-key-canary",
        ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      }).ANTHROPIC_BASE_URL,
    ).toBe("https://proxy.example/v1");
  });

  it.each([
    "http://user:URL_CANARY@proxy.example/path?token=URL_CANARY",
    "ftp://URL_CANARY.example",
    "file:///URL_CANARY",
    "javascript:URL_CANARY",
    "https://[URL_CANARY",
    "URL_CANARY",
  ])("rejects %s without echoing URL or key", (url) => {
    try {
      loadConfig({
        ...BASE_ENV,
        ANTHROPIC_API_KEY: "fake-key-canary",
        ANTHROPIC_BASE_URL: url,
      });
      throw new Error("expected config rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain("ANTHROPIC_BASE_URL");
      expect(message).not.toContain("URL_CANARY");
      expect(message).not.toContain("fake-key-canary");
      expect(message).not.toContain("sk-test-fake-not-real-59217");
    }
  });
});
