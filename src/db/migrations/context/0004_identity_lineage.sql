-- R2 (iris_agent#9): identity-level Context lineage — one lineage per Iris
-- identity/data root, many sequential bounded Pi Runtime Sessions.
--
-- Roadmap v13 root contract:
--   one Iris identity/data root
--   → one durable Context lineage
--   → many sequential bounded Pi Runtime Sessions
--
-- Normal rollover must NOT rebuild, reset, copy, or replace Context. The old
-- session-scoped rows are explicitly quarantined (renamed), never silently
-- reinterpreted as identity-level state. migrateDatabase keeps the applied
-- file sha256-pinned, so this file is immutable once applied.
--
-- Strategy (issue #9 "one explicit policy"): QUARANTINE.
--   * context_lineages        → context_lineages_legacy_session_scoped
--   * context_units           → context_units_legacy_session_scoped
-- New identity-level tables are created empty; the Recovery Reconciler
-- rebuilds semantic units from the canonical RuntimeEvent ledger (exactly-once,
-- replayable), not from quarantined Session-local rows.
--
-- Legacy rows keep their bytes for audit/forensics; nothing reads them on the
-- normal Context path. A future verified reconciliation/import procedure may
-- promote them; that is deliberately NOT part of this migration.

ALTER TABLE context_lineages RENAME TO context_lineages_legacy_session_scoped;
ALTER TABLE context_units RENAME TO context_units_legacy_session_scoped;

-- Identity-level lineage: one row per Iris identity/data root.
CREATE TABLE context_lineages (
  context_lineage_id TEXT PRIMARY KEY,

  -- The Pi Runtime Session currently bound to this lineage. Rollover updates
  -- this column; it NEVER creates a new lineage row.
  current_runtime_session_id TEXT NOT NULL,

  context_source_snapshot_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  persona_snapshot_id TEXT NOT NULL,
  declaration_version TEXT NOT NULL,
  continuity_seed_id TEXT,
  runtime_recovery_notice_id TEXT,
  stable_memory_pool_version TEXT,
  provider_profile_id TEXT NOT NULL,
  canonical_system_prompt TEXT NOT NULL,
  system_projection_hash TEXT NOT NULL,
  prepared_at TEXT NOT NULL,

  materialization_id TEXT NOT NULL,
  context_serializer_version TEXT NOT NULL,
  carrier_schema_version TEXT NOT NULL,

  m0_body TEXT,
  m1_body TEXT,
  m0_content_hash TEXT,
  m1_content_hash TEXT,
  m0_materialized_at INTEGER,
  m1_updated_at INTEGER,
  cached_m0_system_hash TEXT,
  cached_m0_model_key TEXT,
  cached_m0_provider_profile_id TEXT,
  last_response_time INTEGER,

  -- R2: watermark in global context_seq space (lineage-monotonic).
  represented_through_context_seq INTEGER NOT NULL DEFAULT 0,
  -- v12 legacy narrow mapping (entrySeq space); v13 authority is context_seq.
  represented_through_entry_seq INTEGER NOT NULL DEFAULT 0,
  -- 窄归档映射（指向 Pi archive entry；非 Context 权威顺序）。
  protected_tail_start_entry_seq INTEGER,
  last_safe_user_anchor_entry_seq INTEGER,
  cleared_reasoning_through_tag INTEGER NOT NULL DEFAULT 0,
  tool_reclaim_watermark INTEGER NOT NULL DEFAULT 0,
  mutation_replay_watermark INTEGER NOT NULL DEFAULT 0,
  deferred_signal_cursor INTEGER NOT NULL DEFAULT 0,

  emergency_state TEXT NOT NULL DEFAULT 'ok',
  last_transform_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Identity-level immutable semantic units. context_seq is monotonically
-- assigned WITHIN the lineage across Runtime Session boundaries, so it is the
-- global Context ordering authority (NOT the Pi Session entrySeq).
CREATE TABLE context_units (
  context_lineage_id TEXT NOT NULL,
  context_seq INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  -- runtime_event_id 与 source_event_id 同源（都是 canonical event id）；
  -- 保留为可空 attribution 列，source_event_id 是 exactly-once 唯一约束。
  runtime_event_id TEXT,
  source_event_id TEXT NOT NULL UNIQUE,
  unit_type TEXT NOT NULL CHECK (
    unit_type IN ('input', 'assistant', 'tool_result')
  ),
  disposition TEXT NOT NULL DEFAULT 'include' CHECK (
    disposition IN ('include', 'reference_only', 'exclude', 'retired')
  ),
  entry_id TEXT,
  -- 窄归档映射（可选）：Pi Session-local entry 序号。v13 禁止把它当作
  -- Context 权威顺序（contextSeq 才是），但 R3 Historian freeze 边界需要
  -- 把 contextSeq watermark 映射回 Pi archive entry 以便窄读取。
  entry_seq INTEGER,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  companion_entry_id TEXT,
  pair_key TEXT,
  paired INTEGER NOT NULL DEFAULT 0 CHECK (paired IN (0, 1)),
  derivation_refs TEXT NOT NULL DEFAULT '{"memoryRefs":[],"compartmentIds":[],"sourceContextUnitIds":[]}',
  schema_version TEXT NOT NULL DEFAULT 'context-unit-v1',
  raw_archive_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_lineage_id, context_seq)
);

CREATE INDEX IF NOT EXISTS idx_context_units_lineage_seq
  ON context_units (context_lineage_id, context_seq);
CREATE INDEX IF NOT EXISTS idx_context_units_lineage_disposition
  ON context_units (context_lineage_id, disposition);

-- Deferred operations and LKG slots are lineage-level state too: they must
-- survive Runtime Session rollover (replay/LKG continuity is per identity,
-- not per session). Quarantine the session-scoped tables and recreate them
-- keyed by context_lineage_id.
ALTER TABLE context_deferred_operations RENAME TO context_deferred_operations_legacy_session_scoped;
ALTER TABLE context_lkg_slots RENAME TO context_lkg_slots_legacy_session_scoped;

CREATE TABLE IF NOT EXISTS context_deferred_operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  context_lineage_id TEXT NOT NULL,
  op_kind TEXT NOT NULL,
  op_payload TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  consumed_after_cursor INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_deferred_lineage
  ON context_deferred_operations(context_lineage_id, seq);

-- LKG slots: the safe recovery prefix for the provider-visible transform.
-- Bounded: one row per (context_lineage_id, slot_key).
CREATE TABLE IF NOT EXISTS context_lkg_slots (
  context_lineage_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  lkg_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (context_lineage_id, slot_key)
);
