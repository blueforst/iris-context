-- R1: runtime-event ledger bootstrap.
-- Immutable, contextSeq-sorted event ledger (Roadmap v13 canonical chain).
-- exactly-once: idempotency_key UNIQUE (re-insert returns the existing row).

CREATE TABLE IF NOT EXISTS runtime_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  runtime_session_id TEXT NOT NULL,
  pi_session_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'message_finalized',
      'turn_committed',
      'tool_execution_committed',
      'session_committed',
      'agent_settled',
      'abort'
    )
  ),
  entry_id TEXT,
  entry_seq INTEGER,
  content_hash TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  is_error INTEGER,
  disposition TEXT NOT NULL DEFAULT 'include' CHECK (disposition IN ('include', 'reference_only', 'exclude')),
  derivation_refs TEXT NOT NULL DEFAULT '{"memoryRefs":[],"compartmentIds":[],"sourceContextUnitIds":[]}',
  context_seq INTEGER,
  raw_archive_ref TEXT,
  occurred_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_session_seq
  ON runtime_events (runtime_session_id, event_seq);
