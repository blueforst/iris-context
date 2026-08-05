-- R3 Historian bootstrap (issue #8 Phase B, Feature B1).
--
-- historian.db is the Historian's OWN durable store. It NEVER reads the
-- Context repository (m0/m1/LKG) and NEVER writes the Pi Session. It owns:
--   session_state        : per-Session processing cursor + status
--   boundary_snapshots   : frozen freeze-time boundaries (B3)
--   compartments         : immutable semantic compartments (B4)
--   segments             : immutable segments within compartments (B4)
--   evidence_sets        : immutable raw evidence (B4)
--   attribution_manifest : per-compartment attribution (B4)
--   publications         : committed historian publications (B5)
--   publication_outbox   : authoritative delivery outbox (B5)
--   memory_assessment_deltas : recall-assessment deltas (B7)
--
-- The DDL is forward-only: new columns/tables are added by new numbered
-- migrations, never by editing this file.

CREATE TABLE IF NOT EXISTS session_state (
  runtime_session_id TEXT PRIMARY KEY,
  processed_through_entry_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','closing','closed','closed_incomplete','corrupt')),
  observed_head_entry_seq INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boundary_snapshots (
  boundary_snapshot_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  observed_head_entry_seq INTEGER NOT NULL,
  eligible_through_entry_seq INTEGER NOT NULL,
  protected_tail_start_entry_seq INTEGER NOT NULL,
  true_raw_eligible_tokens INTEGER NOT NULL,
  narratable_eligible_tokens INTEGER NOT NULL,
  source_range_hash TEXT NOT NULL,
  model_provider_profile TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE (runtime_session_id, observed_head_entry_seq)
);

CREATE TABLE IF NOT EXISTS compartments (
  compartment_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  compartment_sequence INTEGER NOT NULL,
  start_entry_seq INTEGER NOT NULL,
  end_entry_seq INTEGER NOT NULL,
  source_range_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  p1 TEXT,
  p2 TEXT,
  p3 TEXT,
  p4 TEXT,
  importance TEXT,
  episode_type TEXT,
  attribution_manifest_id TEXT,
  publication_sequence INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (runtime_session_id, compartment_sequence)
);

CREATE TABLE IF NOT EXISTS segments (
  segment_id TEXT PRIMARY KEY,
  compartment_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  start_entry_seq INTEGER NOT NULL,
  end_entry_seq INTEGER NOT NULL,
  source_range_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  attribution_manifest_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_sets (
  evidence_set_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  compartment_id TEXT NOT NULL,
  start_entry_seq INTEGER NOT NULL,
  end_entry_seq INTEGER NOT NULL,
  source_range_hash TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attribution_manifests (
  attribution_manifest_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  compartment_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publications (
  publication_sequence INTEGER PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  runtime_session_id TEXT NOT NULL,
  processing_key TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  compartment_ids_json TEXT NOT NULL,
  segment_ids_json TEXT NOT NULL,
  evidence_set_ids_json TEXT NOT NULL,
  assessment_delta_ids_json TEXT,
  continuity_snapshot_id TEXT,
  previous_publication_sequence INTEGER,
  previous_session_processed_through_entry_seq INTEGER,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','delivering','delivered','retry_wait','quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_leased_until TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_outbox (
  outbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL UNIQUE,
  runtime_session_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','delivering','retry_wait','delivered','quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  claim_leased_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_assessment_deltas (
  assessment_id TEXT PRIMARY KEY,
  publication_sequence INTEGER NOT NULL,
  runtime_session_id TEXT NOT NULL,
  target_memory_ref TEXT NOT NULL,
  observed_in_invocation_ids_json TEXT NOT NULL,
  relation TEXT NOT NULL
    CHECK (relation IN ('supports','contradicts','supersedes','retracts','qualifies','uncertain','no_change')),
  basis_evidence_set_ids_json TEXT NOT NULL,
  assessment_confidence REAL NOT NULL,
  suggested_recall_disposition TEXT,
  rationale_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boundary_session ON boundary_snapshots(runtime_session_id);
CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(runtime_session_id, compartment_sequence);
CREATE INDEX IF NOT EXISTS idx_segments_compartment ON segments(compartment_id);
CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence_sets(runtime_session_id);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON publication_outbox(state, claim_leased_until);
CREATE INDEX IF NOT EXISTS idx_publications_session ON publications(runtime_session_id, publication_sequence);
