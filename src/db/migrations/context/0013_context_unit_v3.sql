-- Feature 2（iris-context#2）：single ContextUnit 持久化 + 旧 schema 迁移。
--
-- 目标：context_units 在保留全部既有列（legacy 行仍可读）的前提下，支持
-- 新的统一 ContextUnit（iris.context_unit.v3）持久化：
--   * content_hash_basis 扩展 'v3'（新 canonical content hash basis；
--     v1/v2 保留 —— 旧行 hash basis 不得静默改写）；
--   * unit_type 松弛为可空（新模型 P3 派生单元无 user/assistant/tool_result
--     kind 映射；runtime-origin 单元仍写三值）；
--   * 新增列：
--       unit_schema_id     新行 = 'iris.context_unit.v3'（legacy 行 NULL）；
--       source_ref         JSON ContextUnitSourceRef（DshMessageRef 或通用
--                          source ref；legacy 行 NULL，provenance 仍在旧列）；
--       content_schema_id  新行 = canonical contentSchemaId（legacy 行回填
--                          自 semantic_schema_id）；
--   * 新增 UNIQUE(context_lineage_id, unit_id)：新模型的 exactly-once 锚
--     （同一 sourceRef 解析为同一 unitId → 同一行；unit_id 由 contextId +
--     sourceRef 确定性派生）。
--
-- 迁移原则（forward-only）：
--   * 既有 migration 文件 checksum-pinned，不可修改；本文件是追加迁移；
--   * v1 行（content_hash_basis='v1'，legacy_status='quarantined_legacy'）
--     保持物理隔离，不迁移为 current unit（应用层 fail-closed）；
--   * v2 行（content_hash_basis='v2'）由应用层在 ContextStore.open 时做
--     确定性 v2→v3 迁移（sha256 canonical JSON 无法在 SQL 中计算；
--     幂等、crash-safe、identity/content/contextSeq 原值保留）；
--   * 本文件只做物理层结构扩展 + 确定性回填（content_schema_id）。

-- 1) 表重建：SQLite 无法原地改 CHECK，按 historian 0012 模式
--    CREATE new → COPY → DROP → RENAME → 重建索引。
CREATE TABLE context_units_new (
  context_lineage_id TEXT NOT NULL,
  context_seq INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  runtime_event_id TEXT,
  source_event_id TEXT NOT NULL UNIQUE,
  -- 松弛为可空：新模型 P3 派生单元无 kind 映射（runtime 单元仍写
  -- 'input'/'assistant'/'tool_result'）。
  unit_type TEXT,
  disposition TEXT NOT NULL DEFAULT 'include' CHECK (
    disposition IN ('include', 'reference_only', 'exclude', 'retired')
  ),
  entry_id TEXT,
  entry_seq INTEGER,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  companion_entry_id TEXT,
  pair_key TEXT,
  paired INTEGER NOT NULL DEFAULT 0 CHECK (paired IN (0, 1)),
  derivation_refs TEXT NOT NULL DEFAULT '{"memoryRefs":[],"compartmentIds":[],"sourceContextUnitIds":[]}',
  schema_version TEXT NOT NULL DEFAULT 'context-unit-v1',
  raw_archive_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'committed' CHECK (
    lifecycle_state IN (
      'committed',
      'historian_eligible',
      'historian_claimed',
      'compartmentalized_pending_bust',
      'represented_in_p3',
      'retired'
    )
  ),
  content_hash_basis TEXT NOT NULL DEFAULT 'v1' CHECK (
    content_hash_basis IN ('v1', 'v2', 'v3')
  ),
  legacy_status TEXT NOT NULL DEFAULT 'none' CHECK (
    legacy_status IN ('none', 'quarantined_legacy')
  ),
  payload_reclaimed_at TEXT,
  created_at TEXT NOT NULL,
  semantic_schema_id TEXT,
  -- Feature 2 新列（见文件头注释）。
  unit_schema_id TEXT,
  source_ref TEXT,
  content_schema_id TEXT,
  PRIMARY KEY (context_lineage_id, context_seq)
);

-- 2) 全量拷贝（显式列清单；新列保持 NULL/缺省）。
INSERT INTO context_units_new (
  context_lineage_id, context_seq, unit_id, runtime_event_id, source_event_id,
  unit_type, disposition, entry_id, entry_seq, content_hash, payload,
  companion_entry_id, pair_key, paired, derivation_refs, schema_version,
  raw_archive_ref, lifecycle_state, content_hash_basis, legacy_status,
  payload_reclaimed_at, created_at, semantic_schema_id
)
SELECT
  context_lineage_id, context_seq, unit_id, runtime_event_id, source_event_id,
  unit_type, disposition, entry_id, entry_seq, content_hash, payload,
  companion_entry_id, pair_key, paired, derivation_refs, schema_version,
  raw_archive_ref, lifecycle_state, content_hash_basis, legacy_status,
  payload_reclaimed_at, created_at, semantic_schema_id
FROM context_units;

-- 3) 原子替换。
DROP TABLE context_units;
ALTER TABLE context_units_new RENAME TO context_units;

-- 4) 重建索引（原 0004 两个 + 新模型 exactly-once 锚）。
CREATE INDEX IF NOT EXISTS idx_context_units_lineage_seq
  ON context_units (context_lineage_id, context_seq);
CREATE INDEX IF NOT EXISTS idx_context_units_lineage_disposition
  ON context_units (context_lineage_id, disposition);
-- 新模型 exactly-once：同一 (context_lineage_id, unit_id) 恰一行。
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_units_lineage_unit_id
  ON context_units (context_lineage_id, unit_id);

-- 5) 确定性回填：content_schema_id 自 semantic_schema_id（全部行，含 legacy）。
UPDATE context_units
  SET content_schema_id = semantic_schema_id
  WHERE content_schema_id IS NULL AND semantic_schema_id IS NOT NULL;
