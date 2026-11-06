ALTER TABLE "repair_attempts" ADD COLUMN "regression_test" jsonb;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "regression_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "repair_attempts" ADD COLUMN "regression_candidate" jsonb;--> statement-breakpoint
ALTER TABLE "run_context_items" ADD COLUMN "content" text;