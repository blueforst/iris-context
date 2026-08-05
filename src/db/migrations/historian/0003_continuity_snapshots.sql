-- R3 Historian (issue #8 Phase B, Feature B6): ContinuitySnapshot storage.
CREATE TABLE IF NOT EXISTS continuity_snapshots (
  continuity_snapshot_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  snapshot_sequence INTEGER NOT NULL,
  final_head_entry_seq INTEGER NOT NULL,
  source_range_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (runtime_session_id, snapshot_sequence)
);
CREATE INDEX IF NOT EXISTS idx_continuity_session ON continuity_snapshots(runtime_session_id, snapshot_sequence DESC);
