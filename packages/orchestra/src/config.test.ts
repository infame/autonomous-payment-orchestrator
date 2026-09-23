import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const VALID_SECRET = "s".repeat(32);
const VALID_KEY = "k".repeat(32);

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://apo:apo@localhost:5433/apo",
    AGENT_ORCHESTRATOR_URL: "http://localhost:3200",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("parses a minimal valid env with sensible defaults", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.PORT).toBe(3300);
    expect(cfg.HOST).toBe("0.0.0.0");
    expect(cfg.GRANT_DEFAULT_TTL_SECONDS).toBe(86_400);
    expect(cfg.GRANT_DEFAULT_MAX_CALLS).toBe(20);
    expect(cfg.LIVE_CALLS_PER_DAY).toBe(200);
    expect(cfg.MIGRATE_ON_BOOT).toBe(true);
    expect(cfg.ADMIN_SECRET).toBeUndefined();
  });

  it("throws ConfigError when DATABASE_URL is missing", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("throws ConfigError when AGENT_ORCHESTRATOR_URL is not a URL", () => {
    expect(() =>
      loadConfig(baseEnv({ AGENT_ORCHESTRATOR_URL: "not-a-url" })),
    ).toThrow(ConfigError);
  });

  it("accepts ADMIN_SECRET + GRANT_SIGNING_KEY + PUBLIC_BASE_URL together", () => {
    const cfg = loadConfig(
      baseEnv({
        ADMIN_SECRET: VALID_SECRET,
        GRANT_SIGNING_KEY: VALID_KEY,
        PUBLIC_BASE_URL: "http://localhost:3300",
      }),
    );
    expect(cfg.ADMIN_SECRET).toBe(VALID_SECRET);
  });

  it("ADMIN_SECRET without GRANT_SIGNING_KEY fails boot", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          ADMIN_SECRET: VALID_SECRET,
          PUBLIC_BASE_URL: "http://localhost:3300",
        }),
      ),
    ).toThrow(/GRANT_SIGNING_KEY is required when ADMIN_SECRET is set/);
  });

  it("ADMIN_SECRET without PUBLIC_BASE_URL fails boot", () => {
    expect(() =>
      loadConfig(
        baseEnv({ ADMIN_SECRET: VALID_SECRET, GRANT_SIGNING_KEY: VALID_KEY }),
      ),
    ).toThrow(/PUBLIC_BASE_URL is required when ADMIN_SECRET is set/);
  });

  it("rejects an ADMIN_SECRET shorter than 32 characters", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          ADMIN_SECRET: "too-short",
          GRANT_SIGNING_KEY: VALID_KEY,
          PUBLIC_BASE_URL: "http://localhost:3300",
        }),
      ),
    ).toThrow(ConfigError);
  });

  it("a present-but-empty numeric var fails loudly rather than becoming 0", () => {
    expect(() =>
      loadConfig(baseEnv({ GRANT_DEFAULT_TTL_SECONDS: "" })),
    ).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ GRANT_DEFAULT_MAX_CALLS: "" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(baseEnv({ LIVE_CALLS_PER_DAY: "" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(baseEnv({ SHUTDOWN_TIMEOUT_MS: "" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(baseEnv({ PORT: "" }))).toThrow(ConfigError);
  });

  it("canary: ConfigError never contains a secret's value, even on a validation failure involving that field", () => {
    const secretValue = "super-secret-value-that-must-never-leak-32c";
    let caught: unknown;
    try {
      loadConfig(
        baseEnv({
          ADMIN_SECRET: secretValue,
          // Deliberately omit GRANT_SIGNING_KEY to force a superRefine
          // issue that names ADMIN_SECRET's sibling field, while
          // ADMIN_SECRET's own (valid) value is still in scope in cfg.
          PUBLIC_BASE_URL: "http://localhost:3300",
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).not.toContain(secretValue);

    // Also canary the DATABASE_URL path, which typically embeds a password.
    let caught2: unknown;
    try {
      loadConfig(
        baseEnv({
          DATABASE_URL: "postgres://apo:sw0rdfish-secret@localhost:5433/apo",
          AGENT_ORCHESTRATOR_URL: "not-a-url",
        }),
      );
    } catch (err) {
      caught2 = err;
    }
    expect(caught2).toBeInstanceOf(ConfigError);
    const message2 = caught2 instanceof Error ? caught2.message : "";
    expect(message2).not.toContain("sw0rdfish-secret");
  });
});
