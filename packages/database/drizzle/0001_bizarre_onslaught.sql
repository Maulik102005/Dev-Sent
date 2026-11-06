CREATE TYPE "public"."run_mode" AS ENUM('TEST', 'FIX');--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'REJECTED' BEFORE 'FAILED';--> statement-breakpoint
DROP INDEX "outbox_events_unpublished_idx";--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lock_owner" varchar(200);--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mode" "run_mode" DEFAULT 'FIX' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "authorization_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "authorization_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("published_at","available_at","created_at");