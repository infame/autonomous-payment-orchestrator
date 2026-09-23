import { z } from "zod";

/** ISO-4217 alpha-3, uppercase. Deliberately a subset of what
 *  `resolvePolicyConfig` (policy/rules.ts) checks — see the comment on
 *  `POLICY_ALLOWED_CURRENCIES` below for why the zero-decimal-currency
 *  rejection stays there and is not duplicated here. */
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Process-level configuration, parsed once at boot (`main.ts`, spec step 8's
 * fourth slice — not built yet). Not exported from `index.ts` — this is
 * bootstrap wiring for the runnable service, not library surface; consumers
 * embedding `@apo/agent-orchestrator` build their own port implementations
 * (`AnthropicClientOptions`, `AnthropicLlmClientOptions`,
 * `HttpDurableLedgerClientOptions`, `ApproveIntent`'s constructor args, ...)
 * directly. Mirrors `@apo/pay-core`'s and `@apo/durable-ledger`'s
 * `config.ts` in shape and doc-comment style.
 */
export const AppConfig = z
  .object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(3200),
    HOST: z.string().min(1).default("0.0.0.0"),

    LLM_MODE: z.enum(["mock", "live"]).default("mock"),
    // Never a z.enum — see the comment above ConfigError: a secret-bearing
    // field must never be a z.enum, since z.enum's own invalid-value error
    // message echoes the received value verbatim.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5"),
    ANTHROPIC_BASE_URL: z
      .string()
      .url()
      .refine(
        (value) => {
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "must be an HTTPS URL" },
      )
      .optional(),
    // Same FOO=""->0 trap as POLICY_DAILY_RATE_LIMIT below (an env var set
    // but left empty does NOT trigger `.optional()`'s undefined-only
    // fallback, and z.coerce.number() turns "" into 0) — but here 0 is a
    // legal, meaningfully different value (no SDK-level retries at all), so
    // `.positive()` isn't available as a fix. `z.preprocess` maps an empty
    // string to `undefined` before coercion, so a blank env line falls back
    // to "unset" (SDK's own default) instead of silently becoming an
    // explicit "never retry".
    ANTHROPIC_MAX_RETRIES: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().min(0).optional(),
    ),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    DURABLE_LEDGER_URL: z.string().url(),
    // Required for every durable-ledger business request. Never a z.enum:
    // configuration errors must not echo a secret value.
    DURABLE_LEDGER_SERVICE_SECRET: z.string().min(32),
    DURABLE_LEDGER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10_000),

    PAYMENT_METHOD_TOKEN: z
      .string()
      .min(1)
      .refine((v) => v.trim() !== "", {
        message: "PAYMENT_METHOD_TOKEN must not be blank",
      }),

    // Validates shape/non-empty/no-duplicates ONLY. The zero-decimal-currency
    // rejection (and any other policy-domain authority) stays inside
    // `resolvePolicyConfig` (policy/rules.ts) — deliberately NOT duplicated
    // here, because `ZERO_DECIMAL_CURRENCIES`/its own `CURRENCY_CODE` are
    // module-private there, and exporting them just to serve bootstrap code
    // would widen `policy/rules.js`'s public surface (it is `export *`-ed
    // from `index.ts`) and let it drift from the policy domain over time.
    // The composition root (slice 4) MUST still call `resolvePolicyConfig`
    // with this value — this check is not a substitute for that call, only
    // a boot-time sanity check on the raw env string.
    POLICY_ALLOWED_CURRENCIES: z
      .string()
      .default("USD,EUR,GBP")
      .transform((v) =>
        v
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== ""),
      )
      .pipe(
        z
          .array(
            z
              .string()
              .regex(
                CURRENCY_CODE,
                "must be an uppercase ISO-4217 alpha-3 code",
              ),
          )
          .nonempty("must list at least one currency")
          .refine((cs) => new Set(cs).size === cs.length, {
            message: "must not contain duplicates",
          }),
      ),
    // .safe() for parity with resolvePolicyConfig's own Number.isSafeInteger
    // check on both amount fields (policy/rules.ts).
    POLICY_MAX_AUTO_APPROVE_AMOUNT: z.coerce
      .number()
      .int()
      .positive()
      .safe()
      .default(50_000),
    POLICY_MAX_HARD_LIMIT_AMOUNT: z.coerce
      .number()
      .int()
      .positive()
      .safe()
      .default(500_000),
    // .positive(), not .min(0), even though resolvePolicyConfig itself
    // allows 0 (a deliberate "reject every intent" kill-switch,
    // Number.isInteger && >= 0). An env var set as `POLICY_DAILY_RATE_LIMIT=`
    // (present but empty) does NOT trigger `.default()` — only `undefined`
    // does that — and `z.coerce.number()` turns `""` into `0`. Without
    // `.positive()` that accidental blank env line would silently become a
    // live "reject every intent" config instead of a loud boot failure. The
    // deliberate kill-switch stays reachable through the programmatic
    // `resolvePolicyConfig` API directly, just not through this env-var path.
    // (`ANTHROPIC_MAX_RETRIES` above hits the same FOO=""->0 trap but can't
    // use `.positive()` — see its own comment for why "" is preprocessed
    // into `undefined` there instead. "Blank env line always fails loudly"
    // is not a universal property of this file — it holds field-by-field,
    // by whichever mechanism fits that field's legal value range.)
    POLICY_DAILY_RATE_LIMIT: z.coerce.number().int().positive().default(10),

    MIGRATE_ON_BOOT: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((cfg, ctx) => {
    // Spec §12's DoD: "the service refuses to boot in live mode without an
    // API key" — reject at boot, not at the first LLM call.
    if (cfg.LLM_MODE === "live" && cfg.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when LLM_MODE=live",
      });
    }
    // Strict `<`, matching resolvePolicyConfig's own check (policy/rules.ts):
    // `maxHardLimitAmount < maxAutoApproveAmount` throws, so equality is
    // legal — a hard limit equal to the auto-approve threshold is a
    // degenerate but valid policy (nothing between "auto-approve" and
    // "hard reject"), not a config error.
    if (cfg.POLICY_MAX_HARD_LIMIT_AMOUNT < cfg.POLICY_MAX_AUTO_APPROVE_AMOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["POLICY_MAX_HARD_LIMIT_AMOUNT"],
        message:
          "POLICY_MAX_HARD_LIMIT_AMOUNT must be >= POLICY_MAX_AUTO_APPROVE_AMOUNT",
      });
    }
  });
export type AppConfig = z.infer<typeof AppConfig>;

/** Raised when process env fails to satisfy `AppConfig`. Never includes the
 * value of any variable in its message (`DATABASE_URL`/`ANTHROPIC_API_KEY`/
 * `DURABLE_LEDGER_SERVICE_SECRET`/`PAYMENT_METHOD_TOKEN` carry secrets) — only the field path and Zod's
 * issue message, one issue per line. This is also why none of those
 * fields is ever a `z.enum`: a `z.enum`'s own invalid-value error message
 * echoes the received value verbatim (e.g. `"received 'yes'"`), which would
 * leak a secret straight into a `ConfigError` message. `LLM_MODE` and
 * `MIGRATE_ON_BOOT` are `z.enum` safely because neither is ever secret — but
 * that must never be forgotten if a future secret-bearing var is added. */
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
 *
 * Known limitation: "every issue at once" only holds for vars that are
 * PRESENT but invalid. A MISSING required var (or a non-numeric value where
 * a number is coerced) aborts the whole `.parse()` call before Zod ever
 * reaches the `superRefine` cross-field checks below, so those issues won't
 * appear in the same `ConfigError` — fixing the missing var and calling
 * `loadConfig` again is what would then surface them.
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
