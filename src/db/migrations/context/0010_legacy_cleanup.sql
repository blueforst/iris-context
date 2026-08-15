-- v27–v29 Context cleanup (Phase C): remove deprecated physical state from
-- context.db while keeping every earlier migration file byte-identical
-- (existing-data-root compatibility: old databases open through 0001–0009
-- exactly as before, then this migration cleans the deprecated surface).
--
-- Deprecated concepts removed (Notion v27 Legacy Assembly Contract Cleanup /
-- Durable-only Live Layer Override / Bounded context.db / Bust-driven
-- Retirement Override):
--   * LKG slots            -> context_lkg_slots (+ legacy_session_scoped)
--   * deferred operations  -> context_deferred_operations (+ legacy)
--   * m0/m1 materialization bytes, cached m0 markers, materialization id,
--     carrier/serializer versions, ContextSourceSnapshot identity
--     (context_source_snapshot_id / epoch / persona / declaration /
--     continuity_seed / runtime_recovery_notice / stable_memory_pool),
--     v12 entrySeq-space watermarks and replay watermarks on context_lineages.
--
-- The quarantined session-scoped lineage/unit tables
-- (context_lineages_legacy_session_scoped / context_units_legacy_session_scoped,
-- created by 0004) keep their bytes for audit/forensics and are NOT dropped.
-- The canonical identity-level context_lineages row keeps only its current
-- Context state (binding, provider profile attribution, represented watermark,
-- emergency state, audit times).

DROP TABLE IF EXISTS context_lkg_slots;
DROP TABLE IF EXISTS context_lkg_slots_legacy_session_scoped;
DROP TABLE IF EXISTS context_deferred_operations;
DROP TABLE IF EXISTS context_deferred_operations_legacy_session_scoped;

-- ContextSourceSnapshot / materialization identity (v27 deprecated).
ALTER TABLE context_lineages DROP COLUMN context_source_snapshot_id;
ALTER TABLE context_lineages DROP COLUMN epoch_id;
ALTER TABLE context_lineages DROP COLUMN persona_snapshot_id;
ALTER TABLE context_lineages DROP COLUMN declaration_version;
ALTER TABLE context_lineages DROP COLUMN continuity_seed_id;
ALTER TABLE context_lineages DROP COLUMN runtime_recovery_notice_id;
ALTER TABLE context_lineages DROP COLUMN stable_memory_pool_version;
ALTER TABLE context_lineages DROP COLUMN materialization_id;
ALTER TABLE context_lineages DROP COLUMN context_serializer_version;
ALTER TABLE context_lineages DROP COLUMN carrier_schema_version;

-- m0/m1 materialized bytes + cached m0 markers (m0/m1 deprecated).
ALTER TABLE context_lineages DROP COLUMN m0_body;
ALTER TABLE context_lineages DROP COLUMN m1_body;
ALTER TABLE context_lineages DROP COLUMN m0_content_hash;
ALTER TABLE context_lineages DROP COLUMN m1_content_hash;
ALTER TABLE context_lineages DROP COLUMN m0_materialized_at;
ALTER TABLE context_lineages DROP COLUMN m1_updated_at;
ALTER TABLE context_lineages DROP COLUMN cached_m0_system_hash;
ALTER TABLE context_lineages DROP COLUMN cached_m0_model_key;
ALTER TABLE context_lineages DROP COLUMN cached_m0_provider_profile_id;
ALTER TABLE context_lineages DROP COLUMN last_response_time;

-- v12 entrySeq-space watermarks + replay watermarks (contextSeq is the only
-- Context ordering authority; entrySeq survives only inside rawArchiveRef).
ALTER TABLE context_lineages DROP COLUMN represented_through_entry_seq;
ALTER TABLE context_lineages DROP COLUMN protected_tail_start_entry_seq;
ALTER TABLE context_lineages DROP COLUMN last_safe_user_anchor_entry_seq;
ALTER TABLE context_lineages DROP COLUMN cleared_reasoning_through_tag;
ALTER TABLE context_lineages DROP COLUMN tool_reclaim_watermark;
ALTER TABLE context_lineages DROP COLUMN mutation_replay_watermark;
ALTER TABLE context_lineages DROP COLUMN deferred_signal_cursor;
