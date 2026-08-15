/**
 * Historian migration 测试（Phase D）。
 * - 空 DB 初始化 0001-0011 全部迁移成功；
 * - 0011 删除 continuity_snapshots / memory_assessment_deltas / segments /
 *   evidence_sets；session_state 删除 finalization_requested_at；
 *   historian_batches / publications 新列 / compartments contextSeq 列存在；
 * - existing-data-root 兼容：0001-0010 老库能继续打开并应用 0011。
 */
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { migrateDatabase } from "../src/db/migrate.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations/historian", import.meta.url));

function tablesOf(db: { prepare(sql: string): { all(): unknown[] } }): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

test("historian migrations: empty DB applies 0001-0011 fully and idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-hm-empty-"));
  try {
    const dbPath = join(dir, "historian.db");
    const result = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.ok(result.appliedVersions.length >= 11, "0001-0011 applied");
    assert.ok(
      result.appliedVersions.includes("0001_bootstrap") &&
        result.appliedVersions.includes("0011_phase_d_provider_neutral"),
      "first and last migration applied",
    );
    const reopened = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.equal(reopened.appliedVersions.length, 0, "re-open applies nothing");
  } finally {
    rm(dir);
  }
});

test("historian migrations: 0011 drops superseded tables and finalizer column", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-hm-drop-"));
  try {
    const dbPath = join(dir, "historian.db");
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const db = new DatabaseSync(dbPath);
    const tables = tablesOf(db);
    for (const dropped of [
      "continuity_snapshots",
      "memory_assessment_deltas",
      "segments",
      "evidence_sets",
    ]) {
      assert.ok(!tables.has(dropped), `${dropped} dropped`);
    }
    for (const kept of [
      "session_state",
      "compartments",
      "publications",
      "publication_outbox",
      "lineage_cursors",
      "compartment_release_state",
      "archive_shards",
      "historian_batches",
    ]) {
      assert.ok(tables.has(kept), `${kept} kept`);
    }
    const sessionColumns = columnsOf(db, "session_state");
    assert.ok(!sessionColumns.includes("finalization_requested_at"), "finalizer column dropped");
    assert.ok(sessionColumns.includes("retry_attempts"), "retry accounting kept");
    assert.ok(sessionColumns.includes("retry_exhausted_at"), "retry exhaustion kept");

    const batchColumns = columnsOf(db, "historian_batches");
    for (const col of [
      "batch_id",
      "claim_id",
      "context_lineage_id",
      "from_context_seq",
      "through_context_seq",
      "range_hash",
      "state",
      "receipt_id",
      "receipt_json",
      "acked_at",
    ]) {
      assert.ok(batchColumns.includes(col), `historian_batches.${col}`);
    }
    const publicationColumns = columnsOf(db, "publications");
    for (const col of [
      "batch_id",
      "claim_id",
      "lineage_id",
      "from_context_seq",
      "through_context_seq",
      "range_hash",
      "processing_profile_id",
      "observations_json",
      "compartment_revisions_json",
    ]) {
      assert.ok(publicationColumns.includes(col), `publications.${col}`);
    }
    const compartmentColumns = columnsOf(db, "compartments");
    for (const col of ["lineage_id", "start_context_seq", "end_context_seq"]) {
      assert.ok(compartmentColumns.includes(col), `compartments.${col}`);
    }
    const releaseColumns = columnsOf(db, "compartment_release_state");
    for (const col of ["start_context_seq", "end_context_seq"]) {
      assert.ok(releaseColumns.includes(col), `compartment_release_state.${col}`);
    }
    db.close();
  } finally {
    rm(dir);
  }
});

test("historian migrations: existing 0001-0010-era DB opens and applies 0011+0012", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-hm-compat-"));
  try {
    const dbPath = join(dir, "historian.db");
    // 只应用 0001-0010 的迁移文件（模拟老库）。
    const legacyDir = mkdtempSync(join(dir, "legacy-migrations-"));
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      if (file.startsWith("0011") || file.startsWith("0012")) {
        continue;
      }
      copyFileSync(join(MIGRATIONS_DIR, file), join(legacyDir, file));
    }
    const legacy = migrateDatabase(dbPath, legacyDir);
    assert.ok(!legacy.appliedVersions.includes("0011_phase_d_provider_neutral"));
    let db = new DatabaseSync(dbPath);
    assert.ok(tablesOf(db).has("continuity_snapshots"), "legacy DB has continuity_snapshots");
    assert.ok(
      tablesOf(db).has("memory_assessment_deltas"),
      "legacy DB has memory_assessment_deltas",
    );
    db.close();

    // 用完整迁移目录重开：0011+0012 追加应用。
    const result = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.deepEqual(result.appliedVersions, [
      "0011_phase_d_provider_neutral",
      "0012_batch_skipped_state",
    ]);
    db = new DatabaseSync(dbPath);
    assert.ok(!tablesOf(db).has("continuity_snapshots"), "0011 drops continuity_snapshots");
    assert.ok(tablesOf(db).has("historian_batches"), "0011 creates historian_batches");
    // 0012 重建后 state CHECK 允许 'skipped'。
    const insert = db.prepare(
      "INSERT INTO historian_batches (batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq, range_hash, semantic_schema_ids_json, unit_count, estimated_tokens, frozen_at, lease_expires_at, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'skipped',?,?)",
    );
    insert.run(
      "b-skip",
      "c-skip",
      "lineage",
      1,
      1,
      "hash",
      "[]",
      1,
      1,
      "2026-08-05T00:00:00Z",
      "2026-08-05T00:01:00Z",
      "2026-08-05T00:00:00Z",
      "2026-08-05T00:00:00Z",
    );
    db.close();

    // HistorianStore 能以新 schema 打开。
    const store = HistorianStore.open({ databasePath: dbPath });
    store.close();
  } finally {
    rm(dir);
  }
});

function rm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

import { rmSync } from "node:fs";
