-- Iris Context domain model — Session-scoped SQLite authority (context.db).
--
-- Every identity and watermark is scoped by runtime_session_id. A Runtime
-- Session has exactly ONE context lineage (rollover creates a fresh lineage;
-- the old session's rows are never inherited). Context.db NEVER stores a
-- second copy of raw Pi messages — only derived materialization state.
--
-- Authority rules (01 Context Assembly / R2 spec):
--   * source/materialization identity, watermarks and mutation keys all
--     carry runtime_session_id;
--   * migration is forward-only with per-file checksums (migrateDatabase);
--   * a DB whose schema_migrations.max(version) is NEWER than the code's
--     LATEST_MIGRATION_VERSION fails closed (ContextStore.open).
--
-- 0001: bootstrap — session lineage + materialization identity + m0/m1 state
--       + represented watermarks + protected-tail boundary + replay state +
--       LKG slots + provider/serializer/carrier versions + emergency state.

CREATE TABLE IF NOT EXISTS context_lineages (
  runtime_session_id TEXT PRIMARY KEY,

  -- ContextSourceSnapshot lineage (one immutable lineage per Runtime Session).
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

  -- Materialization identity + provider/serializer/carrier versions.
  materialization_id TEXT NOT NULL,
  context_serializer_version TEXT NOT NULL,
  carrier_schema_version TEXT NOT NULL,

  -- m0/m1 materialized bytes (the cache-sensitive prefix). m0 is the stable
  -- baseline; m1 is the volatile delta. NULL m0_body means "never materialized".
  m0_body TEXT,
  m1_body TEXT,
  m0_content_hash TEXT,
  m1_content_hash TEXT,
  m0_materialized_at INTEGER,
  m1_updated_at INTEGER,

  -- HARD-bust markers (provider-side cache-eviction signals captured in m0).
  cached_m0_system_hash TEXT,
  cached_m0_model_key TEXT,
  cached_m0_provider_profile_id TEXT,
  last_response_time INTEGER,

  -- Represented watermarks (entrySeq is Session-local).
  represented_through_entry_seq INTEGER NOT NULL DEFAULT 0,

  -- Protected-tail boundary (entrySeq is Session-local).
  protected_tail_start_entry_seq INTEGER,
  last_safe_user_anchor_entry_seq INTEGER,

  -- Replay state (persistent mutations must replay on every pass).
  cleared_reasoning_through_tag INTEGER NOT NULL DEFAULT 0,
  tool_reclaim_watermark INTEGER NOT NULL DEFAULT 0,
  mutation_replay_watermark INTEGER NOT NULL DEFAULT 0,
  deferred_signal_cursor INTEGER NOT NULL DEFAULT 0,

  -- Emergency/failure state.
  emergency_state TEXT NOT NULL DEFAULT 'ok'
    CHECK (emergency_state IN ('ok', 'transform_unavailable', 'emergency_fail_closed')),
  last_transform_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_lineages_epoch ON context_lineages(epoch_id);

-- Deferred operations (publish/drop/reasoning) awaiting a legal pass. Ordering
-- is preserved by the monotonic cursor; replay happens on each pass.
CREATE TABLE IF NOT EXISTS context_deferred_operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_session_id TEXT NOT NULL,
  op_kind TEXT NOT NULL,
  op_payload TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  consumed_after_cursor INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_deferred_session
  ON context_deferred_operations(runtime_session_id, seq);

-- LKG slots: the safe recovery prefix for the provider-visible transform.
-- Bounded: one row per (runtime_session_id, slot_key).
CREATE TABLE IF NOT EXISTS context_lkg_slots (
  runtime_session_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  lkg_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (runtime_session_id, slot_key)
);
