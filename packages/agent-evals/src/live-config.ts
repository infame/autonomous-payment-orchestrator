/**
 * `eval:live`'s own env-var config, parsed once by the CLI before any real
 * `LlmClient` is constructed. Deliberately mirrors
 * `@apo/agent-orchestrator/src/config.ts` field-by-field (same Zod shapes,
 * same `ConfigError` message format, same "never a value" discipline) rather
 * than importing it — `config.ts` is bootstrap-only and not exported from
 * that package's `index.ts` (see its own header), and this package's live
 * config is a different shape anyway (`MAX_LIVE_CALLS`/`EVAL_LIVE_K` have no
 * orchestrator equivalent; `LLM_MODE` doesn't exist here because `eval:live`
 * IS the live mode, there is no `mock` choice).
 *
 * This is the ONE place in this package a secret is ever parsed out of
 * `process.env` — everything downstream (`src/live/llm-factory.ts`) only
 * ever receives the already-validated `LiveConfig.ANTHROPIC_API_KEY` value,
 * once, and passes it straight into `@apo/agent-orchestrator`'s
 * `createLlmClient`. `ANTHROPIC_API_KEY` is never a `z.enum` (a `z.enum`'s
 * own invalid-value error message echoes the received value verbatim) and
 * `ConfigError`'s message never includes the value of any variable — only
 * the field path and Zod's issue message, one issue per line, exactly like
 * `config.ts`'s own `ConfigError`.
 */
import { z } from "zod";

export const MAX_K = 100;
export const MAX_LIVE_CALLS_CEILING = 1000;

export const LiveConfig = z
  .object({
    // Required for `--mode live` (enforced below, not by `.min(1)` alone —
    // an ABSENT key and a BLANK key are different failure shapes, and both
    // must be caught here rather than surfacing as a confusing 401 from the
    // vendor on the first real call).
    ANTHROPIC_API_KEY: z
      .string()
      .min(1)
      .refine((v) => v.trim() !== "", {
        message: "ANTHROPIC_API_KEY must not be blank",
      })
      .optional(),
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
    // Same FOO=""->0 trap as config.ts's own ANTHROPIC_MAX_RETRIES: 0 is a
    // legal, meaningfully different value (no SDK-level retries at all), so
    // `.positive()` isn't available as a fix. Preprocess "" to undefined so
    // a blank env line falls back to "unset" (the SDK's own default)
    // instead of silently becoming an explicit "never retry".
    ANTHROPIC_MAX_RETRIES: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().min(0).optional(),
    ),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // A call-count ceiling, not a cost cap (README's Live section). ""
    // fails loudly via `.positive()`, same FOO=""->0 trap as
    // `POLICY_DAILY_RATE_LIMIT` (config.ts): an env var set but left empty
    // does NOT trigger `.default()`'s undefined-only fallback, and
    // `z.coerce.number()` turns "" into 0, which `.positive()` then rejects.
    MAX_LIVE_CALLS: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_LIVE_CALLS_CEILING)
      .default(100),
    // Passes per scenario. Same "" -> 0 -> rejected-by-.positive() shape as
    // MAX_LIVE_CALLS above.
    EVAL_LIVE_K: z.coerce.number().int().positive().max(MAX_K).default(1),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required for --mode live",
      });
    }
  });
export type LiveConfig = z.infer<typeof LiveConfig>;

/** Raised when process env fails to satisfy `LiveConfig`. Never includes the
 * value of any variable in its message — only the field path and Zod's
 * issue message, one issue per line. Mirrors `@apo/agent-orchestrator`'s own
 * `ConfigError` (`config.ts`) in shape and in this same discipline. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Parses `env` into a validated `LiveConfig`. Throws `ConfigError` with
 * every issue listed, one per line, as `"PATH: message"`.
 *
 * Known limitation, same as `config.ts`'s own `loadConfig`: "every issue at
 * once" only holds for vars that are PRESENT but invalid. A MISSING
 * `ANTHROPIC_API_KEY` and a non-numeric `MAX_LIVE_CALLS` do NOT both surface
 * in the same `ConfigError` — the non-numeric coerce fails `.parse()` before
 * Zod ever reaches the `superRefine` cross-field check that reports the
 * missing key.
 */
export function loadLiveConfig(env: NodeJS.ProcessEnv): LiveConfig {
  try {
    return LiveConfig.parse(env);
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
