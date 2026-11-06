ALTER TYPE "public"."run_status" ADD VALUE 'AWAITING_CLARIFICATION' BEFORE 'PUBLISHING';--> statement-breakpoint
CREATE TABLE "run_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"question" text NOT NULL,
	"status" varchar(20) DEFAULT 'OPEN' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"answered_by" text,
	"answer_delivery_id" varchar(100),
	"answer_comment_id" text,
	"answer" text,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_context_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_iteration" integer DEFAULT 0 NOT NULL,
	"kind" varchar(40) NOT NULL,
	"source" varchar(40) NOT NULL,
	"reference" text NOT NULL,
	"content_hash" varchar(64),
	"byte_count" integer DEFAULT 0 NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_inspector_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(30) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_plans" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"suspected_cause" text NOT NULL,
	"evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intended_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_task_briefs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"contract_version" varchar(80) NOT NULL,
	"issue_title" text DEFAULT '' NOT NULL,
	"issue_body" text DEFAULT '' NOT NULL,
	"trigger_comment" text,
	"command_context" text DEFAULT '' NOT NULL,
	"requested_outcome" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authorized_actor" text NOT NULL,
	"source" jsonb NOT NULL,
	"captured_commit_sha" varchar(40),
	"guidance_path" text,
	"guidance_hash" varchar(64),
	"guidance_version" varchar(80),
	"guidance_content" text,
	"repository_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone
);
--> statement-breakpoint
INSERT INTO "run_task_briefs" (
	"run_id", "contract_version", "issue_title", "issue_body",
	"trigger_comment", "command_context", "requested_outcome",
	"acceptance_criteria", "constraints", "approved_paths",
	"excluded_paths", "authorized_actor", "source",
	"captured_commit_sha", "created_at", "sealed_at"
)
SELECT
	r."id",
	'devsentinel-agent/legacy-import',
	coalesce(w."payload" #>> '{issue,title}', ''),
	coalesce(w."payload" #>> '{issue,body}', ''),
	w."payload" #>> '{comment,body}',
	'',
	coalesce(nullif(w."payload" #>> '{issue,title}', ''), 'Historical issue-scoped run #' || r."issue_number"::text),
	jsonb_build_array('Historical acceptance criteria were not captured; use recorded execution evidence'),
	jsonb_build_array('Issue-scoped work only; unrelated failures and improvements are excluded'),
	'[]'::jsonb,
	'[]'::jsonb,
	r."actor_login",
	jsonb_build_object(
		'eventName', w."event_name",
		'activation', r."activation",
		'deliveryId', w."delivery_id",
		'issueId', CASE WHEN w."payload" #>> '{issue,id}' IS NULL THEN NULL ELSE w."payload" #>> '{issue,id}' END,
		'issueCreatedAt', w."payload" #>> '{issue,created_at}',
		'issueUpdatedAt', w."payload" #>> '{issue,updated_at}',
		'commentId', w."payload" #>> '{comment,id}',
		'commentCreatedAt', w."payload" #>> '{comment,created_at}'
	),
	r."target_commit_sha",
	r."created_at",
	CASE WHEN r."target_commit_sha" IS NULL THEN NULL ELSE r."updated_at" END
FROM "runs" r
JOIN "webhook_deliveries" w ON w."id" = r."trigger_delivery_id";
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "failure_classification" varchar(50);--> statement-breakpoint
ALTER TABLE "run_clarifications" ADD CONSTRAINT "run_clarifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_items" ADD CONSTRAINT "run_context_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_inspector_queries" ADD CONSTRAINT "run_inspector_queries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_task_briefs" ADD CONSTRAINT "run_task_briefs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_clarifications_run_idx" ON "run_clarifications" USING btree ("run_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_clarifications_answer_delivery_uidx" ON "run_clarifications" USING btree ("answer_delivery_id");--> statement-breakpoint
CREATE INDEX "run_context_items_run_idx" ON "run_context_items" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_context_items_attempt_reference_uidx" ON "run_context_items" USING btree ("run_id","attempt_iteration","reference");--> statement-breakpoint
CREATE INDEX "run_inspector_queries_run_idx" ON "run_inspector_queries" USING btree ("run_id","created_at");
