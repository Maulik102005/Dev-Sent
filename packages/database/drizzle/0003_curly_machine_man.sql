CREATE TABLE "repair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"iteration" integer NOT NULL,
	"status" varchar(30) NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"proposal" jsonb,
	"verification" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" varchar(100) NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_workflows" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"delivery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_completed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD CONSTRAINT "repair_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_workflows" ADD CONSTRAINT "run_workflows_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repair_attempts_run_iteration_uidx" ON "repair_attempts" USING btree ("run_id","iteration");--> statement-breakpoint
CREATE INDEX "run_events_run_time_idx" ON "run_events" USING btree ("run_id","created_at");