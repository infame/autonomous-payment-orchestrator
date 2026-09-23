-- Hand-edited from drizzle-kit's generated `CREATE SCHEMA "orchestra";`:
-- with `migrationsSchema: "orchestra"` (migrator.ts), drizzle-orm's runtime
-- already runs `CREATE SCHEMA IF NOT EXISTS "orchestra"` itself, on every
-- `migrate()` call, to hold the migration journal — before this migration's
-- own statements run. Without `IF NOT EXISTS` here too, that ordering makes
-- this statement fail with "schema already exists" the very first time
-- migrations are applied. IF NOT EXISTS keeps this idempotent either way.
CREATE SCHEMA IF NOT EXISTS "orchestra";
--> statement-breakpoint
CREATE TABLE "orchestra"."live_budget" (
	"day" date PRIMARY KEY NOT NULL,
	"used_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "live_budget_used_calls_non_negative" CHECK ("orchestra"."live_budget"."used_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orchestra"."live_grants" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_calls" integer NOT NULL,
	"used_calls" integer DEFAULT 0 NOT NULL,
	"bound_session_id" text,
	CONSTRAINT "live_grants_max_calls_positive" CHECK ("orchestra"."live_grants"."max_calls" > 0),
	CONSTRAINT "live_grants_used_calls_non_negative" CHECK ("orchestra"."live_grants"."used_calls" >= 0),
	CONSTRAINT "live_grants_used_within_max" CHECK ("orchestra"."live_grants"."used_calls" <= "orchestra"."live_grants"."max_calls"),
	CONSTRAINT "live_grants_expires_after_issued" CHECK ("orchestra"."live_grants"."expires_at" > "orchestra"."live_grants"."issued_at")
);
