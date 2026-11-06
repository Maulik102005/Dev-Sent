import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client.js";
import { migrateDatabase } from "./migrate.js";
import { getRunDetail } from "./workflow.js";

const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const createdDatabases: string[] = [];

afterAll(async () => {
  for (const name of createdDatabases) {
    await admin.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [name]);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  }
  await admin.end();
});

describe("additive database upgrade", () => {
  it("upgrades a 0005 database while preserving historical runs and unknown usage", async () => {
    const databaseName = `devsentinel_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    createdDatabases.push(databaseName);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const upgradeUrl = new URL(process.env.TEST_DATABASE_URL!);
    upgradeUrl.pathname = `/${databaseName}`;
    const legacy = createDatabase(upgradeUrl.toString());
    const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    try {
      await legacy.client.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
      await legacy.client.unsafe('CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
      for (const entry of journal.entries.filter((item) => item.idx <= 5)) {
        const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
        await legacy.client.unsafe(sql.replaceAll("--> statement-breakpoint", "\n"));
        await legacy.client.unsafe('INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)', [createHash("sha256").update(sql).digest("hex"), entry.when]);
      }

      const [delivery] = await legacy.client<{ id: string }[]>`
        INSERT INTO webhook_deliveries (delivery_id, event_name, action, disposition, payload, processed_at)
        VALUES ('historical-delivery', 'issue_comment', 'created', 'ACCEPTED',
          ${JSON.stringify({ issue: { id: 44, number: 4, title: "Historical quantity bug", body: "Unknown usage must remain unknown" }, comment: { id: 55, body: "/devsentinel fix" } })}::jsonb, now())
        RETURNING id`;
      const [run] = await legacy.client<{ id: string }[]>`
        INSERT INTO runs (trigger_delivery_id, github_installation_id, github_repository_id, repository_full_name,
          default_branch, issue_number, actor_login, activation, mode, status, target_commit_sha, status_reason)
        VALUES (${delivery!.id}, 1, 2, 'owner/legacy', 'main', 4, 'maintainer', 'command', 'FIX', 'NEEDS_HUMAN',
          ${"a".repeat(40)}, 'Historical result') RETURNING id`;
      await legacy.client`
        INSERT INTO run_workflows (run_id, reserved_tokens, attempt_count, delivery)
        VALUES (${run!.id}, 4096, 1, ${JSON.stringify({ mode: "dry-run", historical: true })}::jsonb)`;
      await legacy.client`
        INSERT INTO repair_attempts (run_id, iteration, status, reserved_tokens, input_tokens, output_tokens, reason)
        VALUES (${run!.id}, 1, 'INTERRUPTED', 4096, NULL, NULL, 'Historical usage was never returned')`;

      await migrateDatabase(legacy.db);
      await migrateDatabase(legacy.db);
      const detail = await getRunDetail(legacy.db, run!.id);
      expect(detail?.run).toMatchObject({ repositoryFullName: "owner/legacy", status: "NEEDS_HUMAN", statusReason: "Historical result" });
      expect(detail?.taskBrief).toMatchObject({
        contractVersion: "devsentinel-agent/legacy-import",
        issueTitle: "Historical quantity bug",
        authorizedActor: "maintainer",
        capturedCommitSha: "a".repeat(40),
      });
      expect(detail?.attempts).toHaveLength(1);
      expect(detail?.attempts[0]).toMatchObject({ inputTokens: null, outputTokens: null, reservedTokens: 4096, deliveryEligible: false });
      expect(detail?.workflow).toMatchObject({ reservedTokens: 4096, attemptCount: 1, toolCallCount: 0, inspectorQueryCount: 0, delivery: { mode: "dry-run", historical: true } });
    } finally {
      await legacy.close();
    }
  });
});
