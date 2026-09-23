import { z } from "zod";

/**
 * Process-level configuration, parsed once at boot (`main.ts`). Not
 * exported from any library surface — this package has none (it's a
 * runnable service, `docs/adr/0020-orchestra-gateway-and-the-second-orchestrator-instance.md`).
 * Mirrors `@apo/agent-orchestrator`'s/`@apo/durable-ledger`'s/`@apo/pay-core`'s
 * own `config.ts` in shape and doc-comment style, including its two
 * documented config traps (repeated per-field below, not just here):
 *  (a) a MISSING required var aborts `.parse()` before `superRefine` runs,
 *      so cross-field messages (e.g. `GRANT_SIGNING_KEY` required alongside
 *      `ADMIN_SECRET`) won't appear together with an unrelated missing-var
 *      error in the same `ConfigError` — fixing the missing var and calling
 *      `loadConfig` again is what surfaces them.
 *  (b) `FOO=` (present but empty) does NOT trigger `.default()`/`.optional()`
 *      (`.optional()` only fires on `undefined`), and `z.coerce.number()`
 *      turns `""` into `0` — every numeric field below uses `.positive()`
 *      specifically so a blank env line fails loudly instead of silently
 *      becoming `0`. Secret-bearing string fields (`ADMIN_SECRET`,
 *      `GRANT_SIGNING_KEY`) don't need the same treatment: an empty string
 *      already fails their own `.min(32)` directly, which is itself a loud
 *      failure, not a silent "absent" fallback.
 */
export const AppConfig = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(3300),
    HOST: z.string().min(1).default("0.0.0.0"),

    AGENT_ORCHESTRATOR_URL: z.string().url(),
    // Absent disables grants entirely, independent of ADMIN_SECRET/
    // GRANT_SIGNING_KEY: with no live instance to proxy to, issuing a grant
    // would be a promise this gateway cannot keep. `gateway-app.ts` returns
    // 503 from `POST /internal/grant` when this is unset, per
    // `docs/todo/05-orchestra.md §4`'s routes table.
    AGENT_ORCHESTRATOR_LIVE_URL: z.string().url().optional(),

    // Never a z.enum — see the comment on `ConfigError` below: a
    // secret-bearing field must never be a z.enum, since z.enum's own
    // invalid-value error message echoes the received value verbatim.
    // Absent => `POST /internal/grant` is 404, never 401/403 (same
    // existence-oracle reasoning as ADR-0014's 404-not-403 rule).
    ADMIN_SECRET: z.string().min(32).optional(),
    // Required-if ADMIN_SECRET is set (superRefine below) — a distinct
    // secret from ADMIN_SECRET: one gates who may MINT a grant, the other
    // is what SIGNS it. Two different exposure surfaces (an admin who can
    // create grants should not thereby learn the key that authenticates
    // them on the wire) justify two separate values even though both are
    // required together in practice.
    GRANT_SIGNING_KEY: z.string().min(32).optional(),
    // Required when ADMIN_SECRET is set (superRefine below) — the base URL
    // `POST /internal/grant`'s response embeds into the returned grant link.
    PUBLIC_BASE_URL: z.string().url().optional(),

    GRANT_DEFAULT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(86_400),
    GRANT_DEFAULT_MAX_CALLS: z.coerce.number().int().positive().default(20),
    // Global backstop, independent of any single grant's own maxCalls.
    LIVE_CALLS_PER_DAY: z.coerce.number().int().positive().default(200),

    MIGRATE_ON_BOOT: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.ADMIN_SECRET !== undefined && cfg.GRANT_SIGNING_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GRANT_SIGNING_KEY"],
        message: "GRANT_SIGNING_KEY is required when ADMIN_SECRET is set",
      });
    }
    if (cfg.ADMIN_SECRET !== undefined && cfg.PUBLIC_BASE_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_BASE_URL"],
        message: "PUBLIC_BASE_URL is required when ADMIN_SECRET is set",
      });
    }
  });
export type AppConfig = z.infer<typeof AppConfig>;

/**
 * Raised when process env fails to satisfy `AppConfig`. Never includes the
 * value of any variable in its message (`DATABASE_URL`/`ADMIN_SECRET`/
 * `GRANT_SIGNING_KEY` carry secrets) — only the field path and Zod's issue
 * message, one issue per line. This is also why neither secret field is
 * ever a `z.enum`: its own invalid-value error message echoes the received
 * value verbatim (e.g. `"received 'yes'"`), which would leak a secret
 * straight into a `ConfigError` message. `MIGRATE_ON_BOOT` is a `z.enum`
 * safely because it is never secret.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Parses `env` (defaults to `process.env`) into a validated `AppConfig`.
 * Throws `ConfigError` with every issue listed, one per line, as
 * `"PATH: message"`. See this file's header for the two documented traps
 * this does NOT fully paper over (missing-var-aborts-superRefine, and
 * present-but-empty numeric vars — handled per-field above, not here).
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
