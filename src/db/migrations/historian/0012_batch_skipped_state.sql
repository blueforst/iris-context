-- Phase D（review fix）—— historian_batches 支持 'skipped' 状态。
--
-- 全 exclude 窗口（有效非空批，但无任何可分析单元）不得让 Historian cursor
-- 永久停摆：runner 在同一原子事务内推进 cursor 并把 batch 标记为 'skipped'
-- （不产出 Compartment/Publication/outbox/receipt）。0011 的 CHECK 只允许
-- 'claimed'/'committed'/'failed'，故本迁移重建该表扩展状态机。
--
-- SQLite 无法直接修改 CHECK 约束，采用标准重建模式（CREATE new → COPY →
-- DROP old → RENAME → 重建索引）。forward-only；现有数据完整保留。

-- 1. 新表（含 'skipped' 状态）
CREATE TABLE historian_batches_new (
  batch_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  context_lineage_id TEXT NOT NULL,
  from_context_seq INTEGER NOT NULL,
  through_context_seq INTEGER NOT NULL,
  range_hash TEXT NOT NULL,
  semantic_schema_ids_json TEXT NOT NULL,
  unit_count INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  frozen_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'claimed'
    CHECK (state IN ('claimed','committed','skipped','failed')),
  committed_at TEXT,
  receipt_id TEXT,
  receipt_json TEXT,
  acked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. 拷贝既有数据
INSERT INTO historian_batches_new (
  batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq,
  range_hash, semantic_schema_ids_json, unit_count, estimated_tokens,
  frozen_at, lease_expires_at, state, committed_at, receipt_id, receipt_json,
  acked_at, created_at, updated_at
)
SELECT
  batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq,
  range_hash, semantic_schema_ids_json, unit_count, estimated_tokens,
  frozen_at, lease_expires_at, state, committed_at, receipt_id, receipt_json,
  acked_at, created_at, updated_at
FROM historian_batches;

-- 3. 替换
DROP TABLE historian_batches;
ALTER TABLE historian_batches_new RENAME TO historian_batches;

-- 4. 重建索引
CREATE INDEX IF NOT EXISTS idx_historian_batches_lineage
  ON historian_batches(context_lineage_id, from_context_seq);
CREATE INDEX IF NOT EXISTS idx_historian_batches_pending_ack
  ON historian_batches(state, acked_at);
