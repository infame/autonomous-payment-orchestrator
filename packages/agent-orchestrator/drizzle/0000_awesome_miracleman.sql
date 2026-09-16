-- Hand-edited from drizzle-kit's generated `CREATE SCHEMA "agent";`: with
-- `migrationsSchema: "agent"` (migrator.ts), drizzle-orm's runtime already
-- runs `CREATE SCHEMA IF NOT EXISTS "agent"` itself, on every `migrate()`
-- call, to hold the migration journal — before this migration's own
-- statements run. Without `IF NOT EXISTS` here too, that ordering makes this
-- statement fail with "schema already exists" the very first time
-- migrations are applied. IF NOT EXISTS keeps this idempotent either way.
CREATE SCHEMA IF NOT EXISTS "agent";
--> statement-breakpoint
CREATE TABLE "agent"."intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"intent_text" text NOT NULL,
	"status" text NOT NULL,
	"proposal" jsonb,
	"policy_verdict" jsonb,
	"durable_ledger_event_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intents_status_valid" CHECK ("agent"."intents"."status" IN ('received','needs_clarification','proposed','needs_approval','rejected','executing','completed','failed','needs_review')),
	CONSTRAINT "intents_version_positive" CHECK ("agent"."intents"."version" > 0),
	CONSTRAINT "intents_customer_id_format" CHECK ("agent"."intents"."customer_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "intents_text_bounded" CHECK (length(btrim("agent"."intents"."intent_text")) BETWEEN 1 AND 10000),
	CONSTRAINT "intents_executing_requires_event_id" CHECK ("agent"."intents"."status" NOT IN ('executing','completed','failed','needs_review') OR "agent"."intents"."durable_ledger_event_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "intents_customer_status_updated_at_idx" ON "agent"."intents" USING btree ("customer_id","status","updated_at");
--> statement-breakpoint
-- hand-written: drizzle-kit does not model triggers
CREATE FUNCTION "agent"."reject_event_id_change"() RETURNS trigger AS $$
BEGIN
  IF OLD.durable_ledger_event_id IS NOT NULL
     AND NEW.durable_ledger_event_id IS DISTINCT FROM OLD.durable_ledger_event_id THEN
    RAISE EXCEPTION 'agent.intents.durable_ledger_event_id is set-once: % may not become %',
      OLD.durable_ledger_event_id, NEW.durable_ledger_event_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "intents_event_id_set_once"
  BEFORE UPDATE ON "agent"."intents"
  FOR EACH ROW EXECUTE FUNCTION "agent"."reject_event_id_change"();