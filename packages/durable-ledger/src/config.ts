import { z } from "zod";

/**
 * Process-level configuration, parsed once at boot (`main.ts`). Not exported
 * from `index.ts` — this is bootstrap wiring for the runnable service, not
 * library surface; consumers embedding `@apo/durable-ledger` build their own
 * `CreateDurableLedgerOptions` directly. Mirrors `@apo/pay-core`'s
 * `config.ts` in shape and doc-comment style.
 */
export const AppConfig = z
  .object({
    DATABASE_URL: z.string().min(1),
    // Shared only with trusted service clients. Never use a z.enum here:
    // invalid-value messages for secret-bearing fields must not echo values.
    DURABLE_LEDGER_SERVICE_SECRET: z.string().min(32),
    PAY_CORE_URL: z.string().url(),
    PAY_CORE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    HOST: z.string().min(1).default("0.0.0.0"),
    INNGEST_APP_ID: z.string().min(1).default("apo-durable-ledger"),
    INNGEST_DEV: z
      .enum(["true", "false", "1", "0"])
      .default("1")
      .transform((v) => v === "true" || v === "1"),
    /** Optional SDK-wide override used only by the local dev server. Leave absent in cloud so the SDK keeps its separate cloud API/event defaults. */
    INNGEST_BASE_URL: z.string().url().optional(),
    /** Explicit REST API origin used by `InngestWorkflowRuns`; required in cloud mode because it is separate from the SDK client's event endpoint. */
    INNGEST_API_BASE_URL: z.string().url().optional(),
    INNGEST_SERVE_PATH: z.string().min(1).default("/api/inngest"),
    INNGEST_EVENT_KEY: z.string().min(1).optional(),
    INNGEST_SIGNING_KEY: z.string().min(1).optional(),
    MIGRATE_ON_BOOT: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((cfg, ctx) => {
    // Cloud mode without a signing/event key fails registration/execution
    // requests at first use, not at boot -> reject at boot instead, mirroring
    // pay-core's SIMULATOR_SEED superRefine.
    if (!cfg.INNGEST_DEV && cfg.INNGEST_SIGNING_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INNGEST_SIGNING_KEY"],
        message: "INNGEST_SIGNING_KEY is required when INNGEST_DEV=false",
      });
    }
    if (!cfg.INNGEST_DEV && cfg.INNGEST_EVENT_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INNGEST_EVENT_KEY"],
        message: "INNGEST_EVENT_KEY is required when INNGEST_DEV=false",
      });
    }
    if (!cfg.INNGEST_DEV && cfg.INNGEST_API_BASE_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INNGEST_API_BASE_URL"],
        message: "INNGEST_API_BASE_URL is required when INNGEST_DEV=false",
      });
    }
  });
export type AppConfig = z.infer<typeof AppConfig>;

/** Raised when process env fails to satisfy `AppConfig`. Never includes the
 * value of any variable in its message (`DATABASE_URL`/
 * `DURABLE_LEDGER_SERVICE_SECRET`/`INNGEST_SIGNING_KEY` carry secrets) — only the field path and Zod's issue message, one issue
 * per line. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Parses `env` (defaults to `process.env`) into a validated `AppConfig`.
 * Throws `ConfigError` with every issue listed, one per line, as
 * `"PATH: message"` — the point is a missing `DATABASE_URL` produces one
 * clear boot-time message instead of an opaque failure many frames deep.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return AppConfig.parse(env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      throw new ConfigError(`Invalid configuration:\n${issues}`);
    }
    throw err;
  }
}
