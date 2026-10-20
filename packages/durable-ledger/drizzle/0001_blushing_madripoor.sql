CREATE TABLE "ledger"."execution_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"event_id" text,
	"step" text NOT NULL,
	"phase" text NOT NULL,
	"payment_id" text,
	"operation_id" uuid,
	"idempotency_key" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"error_code" text,
	CONSTRAINT "execution_attempts_step_check" CHECK ("ledger"."execution_attempts"."step" IN ('authorize','capture','post-ledger')),
	CONSTRAINT "execution_attempts_phase_check" CHECK ("ledger"."execution_attempts"."phase" IN ('workflow','resend')),
	CONSTRAINT "execution_attempts_outcome_check" CHECK ("ledger"."execution_attempts"."outcome" IN ('started','succeeded','failed'))
);
--> statement-breakpoint
CREATE INDEX "execution_attempts_run_started_idx" ON "ledger"."execution_attempts" USING btree ("run_id","started_at");