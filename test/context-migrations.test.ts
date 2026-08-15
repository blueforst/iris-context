/**
 * Phase C：context.db migration 测试。
 * - 空 DB 初始化 0001–0011 全部迁移成功（schema_migrations 记录齐全）；
 * - 0010 清理：context_lkg_slots / context_deferred_operations（含 legacy
 *   session-scoped 变体）被 drop；context_lineages 的 m0/m1/carrier/
 *   source-snapshot/replay-watermark 列被 drop；
 * - 0011 建立 canonical runtime_events 表（与 context_units 同一 db）；
 * - 幂等重开（migration 只应用一次）；
 * - existing-data-root 兼容：按 0001–0009 打开过的老库能继续打开并应用 0010/0011。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { migrateDatabase } from "../src/db/migrate.js";
import { ContextStore, LATEST_MIGRATION_VERSION } from "../src/context/context-store.js";
import { cleanupDir, tempDir } from "./helpers/context-fixtures.js";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";

const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations/context", import.meta.url));

function tablesOf(db: { prepare(sql: string): { all(): unknown[] } }): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

test("migrations: empty DB applies 0001-0013 fully and idempotently", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    const result = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.deepEqual(result.appliedVersions, [
      "0001_bootstrap",
      "0002_units",
      "0003_represented_through",
      "0004_identity_lineage",
      "0005_semantic_schema_id",
      "0005_session_lineage_bindings",
      "0006_binding_retention",
      "0007_archive_staging",
      "0008_lifecycle_state",
      "0009_legacy_fence",
      "0010_legacy_cleanup",
      "0011_runtime_events",
      "0012_bust_retirement",
      "0013_context_unit_v3",
    ]);
    const reopened = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.equal(reopened.appliedVersions.length, 0, "re-open applies nothing (idempotent)");
  } finally {
    cleanupDir(dir);
  }
});

test("migrations: 0013 adds unified ContextUnit v3 columns and keeps legacy columns", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const db = new DatabaseSync(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(context_units)")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const col of [
      // Feature 2 新列
      "unit_schema_id",
      "source_ref",
      "content_schema_id",
      // 既有列必须保留（legacy 行仍可读）
      "runtime_event_id",
      "source_event_id",
      "unit_type",
      "disposition",
      "content_hash",
      "payload",
      "companion_entry_id",
      "pair_key",
      "paired",
      "derivation_refs",
      "raw_archive_ref",
      "semantic_schema_id",
      "lifecycle_state",
      "content_hash_basis",
      "legacy_status",
      "payload_reclaimed_at",
    ]) {
      assert.ok(columns.includes(col), `context_units.${col} exists`);
    }
    // content_hash_basis CHECK 扩展 v3；unit_type 松弛为可空。
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='context_units'")
      .get() as {
      sql: string;
    };
    assert.match(sql.sql, /content_hash_basis IN \('v1', 'v2', 'v3'\)/);
    assert.ok(!sql.sql.includes("unit_type TEXT NOT NULL"), "unit_type CHECK relaxed");
    // 新 exactly-once 索引。
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='context_units'")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(indexes.includes("idx_context_units_lineage_unit_id"));
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migrations: 0010 drops deprecated tables and columns", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const db = new DatabaseSync(dbPath);
    const tables = tablesOf(db);
    assert.ok(!tables.has("context_lkg_slots"), "context_lkg_slots dropped");
    assert.ok(!tables.has("context_lkg_slots_legacy_session_scoped"), "legacy lkg slots dropped");
    assert.ok(!tables.has("context_deferred_operations"), "context_deferred_operations dropped");
    assert.ok(
      !tables.has("context_deferred_operations_legacy_session_scoped"),
      "legacy deferred ops dropped",
    );
    const columns = db
      .prepare("PRAGMA table_info(context_lineages)")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const dropped of [
      "m0_body",
      "m1_body",
      "m0_content_hash",
      "m1_content_hash",
      "m0_materialized_at",
      "m1_updated_at",
      "cached_m0_system_hash",
      "cached_m0_model_key",
      "cached_m0_provider_profile_id",
      "carrier_schema_version",
      "context_source_snapshot_id",
      "epoch_id",
      "persona_snapshot_id",
      "declaration_version",
      "continuity_seed_id",
      "runtime_recovery_notice_id",
      "stable_memory_pool_version",
      "materialization_id",
      "context_serializer_version",
      "represented_through_entry_seq",
      "protected_tail_start_entry_seq",
      "last_safe_user_anchor_entry_seq",
      "cleared_reasoning_through_tag",
      "tool_reclaim_watermark",
      "mutation_replay_watermark",
      "deferred_signal_cursor",
      "last_response_time",
    ]) {
      assert.ok(!columns.includes(dropped), `context_lineages.${dropped} dropped`);
    }
    for (const kept of [
      "context_lineage_id",
      "current_runtime_session_id",
      "provider_profile_id",
      "canonical_system_prompt",
      "system_projection_hash",
      "represented_through_context_seq",
      "emergency_state",
      "last_transform_error",
      "created_at",
      "updated_at",
    ]) {
      assert.ok(columns.includes(kept), `context_lineages.${kept} kept`);
    }
    // quarantine 审计表保留（老数据字节审计）。
    assert.ok(tables.has("context_lineages_legacy_session_scoped"));
    assert.ok(tables.has("context_units_legacy_session_scoped"));
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migrations: 0011 creates canonical runtime_events in context.db", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const db = new DatabaseSync(dbPath);
    const tables = tablesOf(db);
    assert.ok(tables.has("runtime_events"));
    const columns = db
      .prepare("PRAGMA table_info(runtime_events)")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const col of [
      "runtime_event_id",
      "context_lineage_id",
      "context_seq",
      "kind",
      "origin",
      "payload_schema_id",
      "payload",
      "payload_hash",
      "idempotency_key",
    ]) {
      assert.ok(columns.includes(col), `runtime_events.${col} exists`);
    }
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migrations: 0012 adds retired watermark + generation binding + payload reclaimed marker", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    migrateDatabase(dbPath, MIGRATIONS_DIR);
    const db = new DatabaseSync(dbPath);
    const lineageColumns = db
      .prepare("PRAGMA table_info(context_lineages)")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const col of [
      "retired_through_context_seq",
      "last_bust_generation_id",
      "last_bust_generation_hash",
      "last_bust_at",
    ]) {
      assert.ok(lineageColumns.includes(col), `context_lineages.${col} exists`);
    }
    const unitColumns = db
      .prepare("PRAGMA table_info(context_units)")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(
      unitColumns.includes("payload_reclaimed_at"),
      "context_units.payload_reclaimed_at exists",
    );
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migrations: existing-data-root compat — a 0001-0009-era DB opens and applies 0010/0011/0012/0013", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    // 模拟老库：只应用 0001-0009 的迁移文件（截断目录到 0009）。
    const legacyDir = mkdtempSync(join(dir, "legacy-migrations-"));
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      if (
        file.startsWith("0010") ||
        file.startsWith("0011") ||
        file.startsWith("0012") ||
        file.startsWith("0013")
      ) {
        continue;
      }
      copyFileSync(join(MIGRATIONS_DIR, file), join(legacyDir, file));
    }
    migrateDatabase(dbPath, legacyDir);
    // 老库有 LKG/deferred 表与 m0 列。
    let db = new DatabaseSync(dbPath);
    assert.ok(tablesOf(db).has("context_lkg_slots"));
    assert.ok(tablesOf(db).has("context_deferred_operations"));
    db.close();
    // 用完整迁移目录重开：0010/0011/0012/0013 追加应用。
    const result = migrateDatabase(dbPath, MIGRATIONS_DIR);
    assert.deepEqual(result.appliedVersions, [
      "0010_legacy_cleanup",
      "0011_runtime_events",
      "0012_bust_retirement",
      "0013_context_unit_v3",
    ]);
    db = new DatabaseSync(dbPath);
    assert.ok(!tablesOf(db).has("context_lkg_slots"));
    assert.ok(tablesOf(db).has("runtime_events"));
    db.close();
    // ContextStore 能以新 schema 打开（full path）。
    const store = ContextStore.open(dbPath);
    store.close();
    assert.equal(LATEST_MIGRATION_VERSION, "0013_context_unit_v3");
  } finally {
    cleanupDir(dir);
  }
});
