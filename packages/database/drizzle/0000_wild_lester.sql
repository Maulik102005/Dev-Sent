CREATE TYPE "public"."delivery_disposition" AS ENUM('RECEIVED', 'ACCEPTED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('AUTHORIZING', 'PREPARING', 'PROVISIONING', 'BASELINING', 'DIAGNOSING', 'PATCHING', 'VERIFYING', 'PUBLISHING', 'SUCCEEDED', 'NEEDS_HUMAN', 'BUDGET_EXHAUSTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(50) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_delivery_id" uuid NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"repository_full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"issue_number" integer NOT NULL,
	"actor_login" text NOT NULL,
	"activation" varchar(20) NOT NULL,
	"status" "run_status" DEFAULT 'AUTHORIZING' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" varchar(100) NOT NULL,
	"event_name" varchar(100) NOT NULL,
	"action" varchar(100),
	"disposition" "delivery_disposition" DEFAULT 'RECEIVED' NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("trigger_delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_trigger_delivery_id_uidx" ON "runs" USING btree ("trigger_delivery_id");--> statement-breakpoint
CREATE INDEX "runs_repository_issue_idx" ON "runs" USING btree ("github_repository_id","issue_number");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_delivery_id_uidx" ON "webhook_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");