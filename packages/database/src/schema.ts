import { runModeValues, runStatusValues } from "@devsentinel/domain";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const deliveryDispositionValues = [
  "RECEIVED",
  "ACCEPTED",
  "IGNORED",
] as const;

export const deliveryDisposition = pgEnum(
  "delivery_disposition",
  deliveryDispositionValues,
);

export const runStatus = pgEnum("run_status", runStatusValues);
export const runMode = pgEnum("run_mode", runModeValues);

export const sandboxExecutionPhaseValues = [
  "DEPENDENCY_INSTALL",
  "BASELINE_TEST",
] as const;
export const sandboxExecutionPhase = pgEnum(
  "sandbox_execution_phase",
  sandboxExecutionPhaseValues,
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: varchar("delivery_id", { length: 100 }).notNull(),
    eventName: varchar("event_name", { length: 100 }).notNull(),
    action: varchar("action", { length: 100 }),
    disposition: deliveryDisposition("disposition")
      .default("RECEIVED")
      .notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_delivery_id_uidx").on(table.deliveryId),
    index("webhook_deliveries_received_at_idx").on(table.receivedAt),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    triggerDeliveryId: uuid("trigger_delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id),
    githubInstallationId: bigint("github_installation_id", {
      mode: "number",
    }).notNull(),
    githubRepositoryId: bigint("github_repository_id", {
      mode: "number",
    }).notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    issueNumber: integer("issue_number").notNull(),
    actorLogin: text("actor_login").notNull(),
    activation: varchar("activation", { length: 20 }).notNull(),
    mode: runMode("mode").default("FIX").notNull(),
    status: runStatus("status").default("AUTHORIZING").notNull(),
    authorizationReason: text("authorization_reason"),
    authorizationCheckedAt: timestamp("authorization_checked_at", {
      withTimezone: true,
    }),
    targetCommitSha: varchar("target_commit_sha", { length: 40 }),
    detectedPackageManager: varchar("detected_package_manager", { length: 20 }),
    statusReason: text("status_reason"),
    failureClassification: varchar("failure_classification", { length: 50 }),
    baselineCompletedAt: timestamp("baseline_completed_at", {
      withTimezone: true,
    }),
    version: integer("version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runs_trigger_delivery_id_uidx").on(table.triggerDeliveryId),
    index("runs_repository_issue_idx").on(
      table.githubRepositoryId,
      table.issueNumber,
    ),
    index("runs_status_idx").on(table.status),
  ],
);

export interface TaskBriefSource {
  eventName: string;
  activation: "label" | "command";
  deliveryId: string;
  issueId: string | null;
  issueCreatedAt: string | null;
  issueUpdatedAt: string | null;
  commentId: string | null;
  commentCreatedAt: string | null;
}

export const runTaskBriefs = pgTable("run_task_briefs", {
  runId: uuid("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  contractVersion: varchar("contract_version", { length: 80 }).notNull(),
  issueTitle: text("issue_title").default("").notNull(),
  issueBody: text("issue_body").default("").notNull(),
  triggerComment: text("trigger_comment"),
  commandContext: text("command_context").default("").notNull(),
  requestedOutcome: text("requested_outcome").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().default([]).notNull(),
  constraints: jsonb("constraints").$type<string[]>().default([]).notNull(),
  approvedPaths: jsonb("approved_paths").$type<string[]>().default([]).notNull(),
  excludedPaths: jsonb("excluded_paths").$type<string[]>().default([]).notNull(),
  authorizedActor: text("authorized_actor").notNull(),
  source: jsonb("source").$type<TaskBriefSource>().notNull(),
  capturedCommitSha: varchar("captured_commit_sha", { length: 40 }),
  guidancePath: text("guidance_path"),
  guidanceHash: varchar("guidance_hash", { length: 64 }),
  guidanceVersion: varchar("guidance_version", { length: 80 }),
  guidanceContent: text("guidance_content"),
  repositoryConfig: jsonb("repository_config").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sealedAt: timestamp("sealed_at", { withTimezone: true }),
});

export const runPlans = pgTable("run_plans", {
  runId: uuid("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  version: integer("version").default(1).notNull(),
  suspectedCause: text("suspected_cause").notNull(),
  evidenceReferences: jsonb("evidence_references").$type<string[]>().default([]).notNull(),
  intendedFiles: jsonb("intended_files").$type<string[]>().default([]).notNull(),
  scopeExclusions: jsonb("scope_exclusions").$type<string[]>().default([]).notNull(),
  verificationSteps: jsonb("verification_steps").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runClarifications = pgTable("run_clarifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  status: varchar("status", { length: 20 }).default("OPEN").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  answeredBy: text("answered_by"),
  answerDeliveryId: varchar("answer_delivery_id", { length: 100 }),
  answerCommentId: text("answer_comment_id"),
  answer: text("answer"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
}, (table) => [
  index("run_clarifications_run_idx").on(table.runId, table.requestedAt),
  uniqueIndex("run_clarifications_answer_delivery_uidx").on(table.answerDeliveryId),
]);

export const runContextItems = pgTable("run_context_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  attemptIteration: integer("attempt_iteration").default(0).notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  source: varchar("source", { length: 40 }).notNull(),
  reference: text("reference").notNull(),
  contentHash: varchar("content_hash", { length: 64 }),
  content: text("content"),
  byteCount: integer("byte_count").default(0).notNull(),
  selected: boolean("selected").default(false).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("run_context_items_run_idx").on(table.runId, table.createdAt),
  uniqueIndex("run_context_items_attempt_reference_uidx").on(table.runId, table.attemptIteration, table.reference),
]);

export const runInspectorQueries = pgTable("run_inspector_queries", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  evidenceReferences: jsonb("evidence_references").$type<string[]>().default([]).notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("run_inspector_queries_run_idx").on(table.runId, table.createdAt)]);

export const sandboxExecutions = pgTable(
  "sandbox_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    phase: sandboxExecutionPhase("phase").notNull(),
    image: text("image").notNull(),
    command: jsonb("command").$type<string[]>().notNull(),
    exitCode: integer("exit_code"),
    timedOut: boolean("timed_out").default(false).notNull(),
    durationMs: integer("duration_ms").notNull(),
    stdout: text("stdout").default("").notNull(),
    stderr: text("stderr").default("").notNull(),
    outputTruncated: boolean("output_truncated").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sandbox_executions_run_phase_idx").on(table.runId, table.phase),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aggregateType: varchar("aggregate_type", { length: 50 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockOwner: varchar("lock_owner", { length: 200 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
  },
  (table) => [
    index("outbox_events_unpublished_idx").on(
      table.publishedAt,
      table.availableAt,
      table.createdAt,
    ),
  ],
);

export const runWorkflows = pgTable("run_workflows", {
  runId: uuid("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  leaseOwner: uuid("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  reservedTokens: integer("reserved_tokens").default(0).notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  toolCallCount: integer("tool_call_count").default(0).notNull(),
  toolOutputBytes: integer("tool_output_bytes").default(0).notNull(),
  inspectorQueryCount: integer("inspector_query_count").default(0).notNull(),
  inspectorReservedTokens: integer("inspector_reserved_tokens").default(0).notNull(),
  delivery: jsonb("delivery").$type<Record<string, unknown>>().default({}).notNull(),
  deliveryCompletedAt: timestamp("delivery_completed_at", { withTimezone: true }),
  lastError: text("last_error"),
});

// Only bounded machine-readable metadata belongs here, never raw provider bodies.
export interface ModelDiagnostics {
  provider: "openai";
  kind: "completed" | "incomplete" | "refused" | "api_error" | "timeout" | "cancelled" | "network_error" | "invalid_response";
  responseId: string | null;
  requestId: string | null;
  status: string | null;
  reason: string | null;
  httpStatus: number | null;
  retryable: boolean;
}

export const repairAttempts = pgTable("repair_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  iteration: integer("iteration").notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  reservedTokens: integer("reserved_tokens").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  estimatedCostMicrousd: bigint("estimated_cost_microusd", { mode: "number" }),
  toolCalls: integer("tool_calls").default(0).notNull(),
  toolOutputBytes: integer("tool_output_bytes").default(0).notNull(),
  toolTrace: jsonb("tool_trace").$type<Array<{ sequence: number; phase: string; tool: string; summary: string; outputBytes: number }>>().default([]).notNull(),
  modelDiagnostics: jsonb("model_diagnostics").$type<ModelDiagnostics>(),
  proposal: jsonb("proposal").$type<{ summary: string; edits: Array<{ path: string; content: string }> }>(),
  regressionTest: jsonb("regression_test").$type<{ summary: string; path: string; content: string; hash: string }>(),
  regressionBaseline: jsonb("regression_baseline").$type<import("./runs.js").RecordedBaselineResult>(),
  regressionCandidate: jsonb("regression_candidate").$type<import("./runs.js").RecordedBaselineResult>(),
  verification: jsonb("verification").$type<import("./runs.js").RecordedBaselineResult>(),
  targetedVerification: jsonb("targeted_verification").$type<import("./runs.js").RecordedBaselineResult>(),
  acceptanceEvidence: jsonb("acceptance_evidence").$type<Array<{ criterion: string; status: "SUPPORTED" | "UNVERIFIED"; evidenceReferences: string[] }>>().default([]).notNull(),
  unrelatedFailures: jsonb("unrelated_failures").$type<string[]>().default([]).notNull(),
  requiredChecksPassed: boolean("required_checks_passed").default(false).notNull(),
  deliveryEligible: boolean("delivery_eligible").default(false).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("repair_attempts_run_iteration_uidx").on(table.runId, table.iteration)]);

export const runApprovals = pgTable("run_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 30 }).notNull(),
  paths: jsonb("paths").$type<string[]>().default([]).notNull(),
  reason: text("reason").notNull(),
  approvedBy: text("approved_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("run_approvals_run_idx").on(table.runId, table.createdAt)]);

export const runEvents = pgTable("run_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 100 }).notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("run_events_run_time_idx").on(table.runId, table.createdAt)]);
