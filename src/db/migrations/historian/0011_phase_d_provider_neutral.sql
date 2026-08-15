-- Phase D (v27/v29) —— Historian provider-neutral 收敛迁移。
--
-- 目标：把 R3-era (v13/v26) 的 Session-scoped historian.db 收敛到 v29 的
-- lineage-scoped、contextSeq 坐标、provider-neutral 模型。
--
-- 删除（v26/v27 废止）：
--   continuity_snapshots      — ContinuitySnapshot/wrapup 废止（v27）；
--   memory_assessment_deltas  — MemoryAssessmentDelta 废止（v26）；
--   segments / evidence_sets  — Session-scoped EvidenceSet/Segment ledger 废止
--                               （v29：CompartmentRevision + provider-neutral
--                               MemoryObservation evidenceBasis 取代）；
--   session_state.finalization_requested_at — wrapup 终结器意图时间戳（v27
--     删除 finalizer 路径后不再需要）。retry_attempts / retry_exhausted_at
--     保留（重试记账 durable）。
--
-- 新增：
--   historian_batches         — claim/lease/commit protocol 的权威 batch 状态
--                               （batchId/claimId/contextLineageId/range/
--                               hash/semanticSchemaIds/token estimate/freeze
--                               time/lease expiry/state/receipt/acked）。
--   publications              — 新列：batch_id/claim_id/lineage_id/
--                               from_context_seq/through_context_seq/range_hash/
--                               processing_profile_id（batch claim 时冻结的
--                               semantic adapter 版本集 hash）/observations_json
--                               （MemoryObservationV1[]）/compartment_revisions_json。
--   compartments              — 新列：lineage_id/start_context_seq/end_context_seq
--                               （CompartmentRevision 的 contextSeq 坐标）。
--   compartment_release_state — 新列：start_context_seq/end_context_seq。
--
-- forward-only；现有 historian.db（0001-0010）可打开并应用本迁移。

-- 1. 废止表删除
DROP TABLE IF EXISTS continuity_snapshots;
DROP TABLE IF EXISTS memory_assessment_deltas;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS evidence_sets;

-- 2. session_state：删除 finalizer-only 列（其索引必须先行删除）
DROP INDEX IF EXISTS idx_session_state_closing_intent;
ALTER TABLE session_state DROP COLUMN finalization_requested_at;

-- 3. historian_batches：claim/lease/commit protocol 权威状态
CREATE TABLE IF NOT EXISTS historian_batches (
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
    CHECK (state IN ('claimed','committed','failed')),
  committed_at TEXT,
  receipt_id TEXT,
  receipt_json TEXT,
  acked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_historian_batches_lineage
  ON historian_batches(context_lineage_id, from_context_seq);
CREATE INDEX IF NOT EXISTS idx_historian_batches_pending_ack
  ON historian_batches(state, acked_at);

-- 4. publications：batch 绑定 + processing profile + provider-neutral 载荷
ALTER TABLE publications ADD COLUMN batch_id TEXT;
ALTER TABLE publications ADD COLUMN claim_id TEXT;
ALTER TABLE publications ADD COLUMN lineage_id TEXT;
ALTER TABLE publications ADD COLUMN from_context_seq INTEGER;
ALTER TABLE publications ADD COLUMN through_context_seq INTEGER;
ALTER TABLE publications ADD COLUMN range_hash TEXT;
ALTER TABLE publications ADD COLUMN processing_profile_id TEXT;
ALTER TABLE publications ADD COLUMN observations_json TEXT;
ALTER TABLE publications ADD COLUMN compartment_revisions_json TEXT;
CREATE INDEX IF NOT EXISTS idx_publications_lineage
  ON publications(lineage_id, publication_sequence);

-- 5. compartments：lineage-scoped 身份 + contextSeq 坐标
ALTER TABLE compartments ADD COLUMN lineage_id TEXT;
ALTER TABLE compartments ADD COLUMN start_context_seq INTEGER;
ALTER TABLE compartments ADD COLUMN end_context_seq INTEGER;
CREATE INDEX IF NOT EXISTS idx_compartments_lineage
  ON compartments(lineage_id, compartment_sequence);

-- 6. compartment_release_state：contextSeq 坐标
ALTER TABLE compartment_release_state ADD COLUMN start_context_seq INTEGER;
ALTER TABLE compartment_release_state ADD COLUMN end_context_seq INTEGER;
