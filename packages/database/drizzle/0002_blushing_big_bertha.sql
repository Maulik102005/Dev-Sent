CREATE TYPE "public"."sandbox_execution_phase" AS ENUM('DEPENDENCY_INSTALL', 'BASELINE_TEST');--> statement-breakpoint
CREATE TABLE "sandbox_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" "sandbox_execution_phase" NOT NULL,
	"image" text NOT NULL,
	"command" jsonb NOT NULL,
	"exit_code" integer,
	"timed_out" boolean DEFAULT false NOT NULL,
	"duration_ms" integer NOT NULL,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"output_truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "target_commit_sha" varchar(40);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "detected_package_manager" varchar(20);--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "baseline_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandbox_executions" ADD CONSTRAINT "sandbox_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_executions_run_phase_idx" ON "sandbox_executions" USING btree ("run_id","phase");