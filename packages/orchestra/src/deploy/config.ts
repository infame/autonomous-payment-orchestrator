import { ConfigError } from "../config.js";

export interface Service {
  readonly name: string;
  readonly port: number;
  readonly env: NodeJS.ProcessEnv;
}

/** Deliberately allowlisted: ambient live credentials and SDK overrides never reach children. */
export function servicePlan(env: NodeJS.ProcessEnv): readonly Service[] {
  const requireValue = (key: string, min = 1): string => {
    const value = env[key];
    if (value === undefined || value.trim().length < min) {
      throw new ConfigError(
        `${key} is required (${String(min)} characters minimum)`,
      );
    }
    return value;
  };
  const local = env.SINGLE_VM_LOCAL_TEST === "true";
  if (env.SINGLE_VM_LOCAL_TEST !== undefined && !local) {
    throw new ConfigError("SINGLE_VM_LOCAL_TEST must be absent or true");
  }
  if (local && env.FLY_APP_NAME !== undefined) {
    throw new ConfigError("Local test mode is forbidden on Fly");
  }
  const origin = requireValue("PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ConfigError("PUBLIC_BASE_URL must be a canonical origin");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (!local && url.protocol !== "https:") ||
    (local && url.protocol !== "http:")
  ) {
    throw new ConfigError(
      "PUBLIC_BASE_URL must be a canonical HTTPS origin (HTTP only in explicit local tests)",
    );
  }
  const common: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DATABASE_URL: requireValue("DATABASE_URL"),
    HOST: "127.0.0.1",
    MIGRATE_ON_BOOT: "true",
    SHUTDOWN_TIMEOUT_MS: "10000",
  };
  const secret = requireValue("DURABLE_LEDGER_SERVICE_SECRET", 32);
  const inngest: NodeJS.ProcessEnv = local
    ? {
        INNGEST_DEV: "true",
        INNGEST_BASE_URL: requireValue("LOCAL_INNGEST_URL"),
        INNGEST_API_BASE_URL: requireValue("LOCAL_INNGEST_URL"),
      }
    : {
        INNGEST_DEV: "false",
        INNGEST_EVENT_KEY: requireValue("INNGEST_EVENT_KEY"),
        INNGEST_SIGNING_KEY: requireValue("INNGEST_SIGNING_KEY"),
        INNGEST_API_BASE_URL: "https://api.inngest.com",
      };
  const service = (
    name: string,
    port: number,
    extra: NodeJS.ProcessEnv,
  ): Service => ({
    name,
    port,
    env: { ...common, PORT: String(port), ...extra },
  });
  return [
    service("pay-core", 3000, {
      PAYMENT_PROVIDER: "simulator",
      SIMULATOR_MODE: "deterministic",
    }),
    service("durable-ledger", 3100, {
      ...inngest,
      PAY_CORE_URL: "http://127.0.0.1:3000",
      DURABLE_LEDGER_SERVICE_SECRET: secret,
      DEMO_RESEND_ENABLED: "true",
      INNGEST_SERVE_PATH: "/api/inngest",
      INNGEST_SERVE_ORIGIN: origin,
    }),
    service("agent-orchestrator", 3200, {
      DURABLE_LEDGER_URL: "http://127.0.0.1:3100",
      DURABLE_LEDGER_SERVICE_SECRET: secret,
      LLM_MODE: "mock",
      PAYMENT_METHOD_TOKEN: "simulator-demo-token",
      DEMO_CHALLENGES_ENABLED: "true",
      DEMO_RESEND_ENABLED: "true",
    }),
    service("orchestra", 3300, {
      HOST: "0.0.0.0",
      AGENT_ORCHESTRATOR_URL: "http://127.0.0.1:3200",
      INNGEST_CALLBACK_URL: "http://127.0.0.1:3100/api/inngest",
      PUBLIC_BASE_URL: origin,
    }),
  ];
}
