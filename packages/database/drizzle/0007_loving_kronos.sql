CREATE TABLE "run_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" varchar(30) NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "estimated_cost_microusd" bigint;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "tool_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "tool_output_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "tool_trace" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "targeted_verification" jsonb;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "acceptance_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "unrelated_failures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "required_checks_passed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "delivery_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_workflows" ADD COLUMN "tool_call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_workflows" ADD COLUMN "tool_output_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_workflows" ADD COLUMN "inspector_query_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_workflows" ADD COLUMN "inspector_reserved_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_approvals_run_idx" ON "run_approvals" USING btree ("run_id","created_at");