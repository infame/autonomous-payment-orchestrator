ALTER TABLE "agent"."intents" ADD COLUMN "execution_profile" text;--> statement-breakpoint
ALTER TABLE "agent"."intents" ADD CONSTRAINT "intents_execution_profile_valid" CHECK ("agent"."intents"."execution_profile" IS NULL OR "agent"."intents"."execution_profile" IN ('demo_ok','demo_transient','demo_decline'));
--> statement-breakpoint
CREATE FUNCTION agent.keep_execution_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_profile IS DISTINCT FROM OLD.execution_profile THEN
    RAISE EXCEPTION 'execution profile is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER intents_execution_profile_immutable BEFORE UPDATE ON agent.intents FOR EACH ROW EXECUTE FUNCTION agent.keep_execution_profile();
