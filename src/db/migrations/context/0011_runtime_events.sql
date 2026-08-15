-- v25+ canonical runtime-event ledger (Notion Canonical Schemas / v25
-- Persistence Mapping Override): `runtime_events` lives IN context.db so
-- CanonicalRuntimeEventV1 and ContextMessageUnitV1 are committed in the SAME
-- SQLite transaction sharing the same `contextSeq` ordering key.
--
-- exactly-once: idempotency_key UNIQUE (re-ingest returns the existing row).
-- context_seq is lineage-global and monotonic (UNIQUE within lineage).
--
-- Attribution columns (runtime_session_id / role / tool_call_id / tool_name /
-- is_error / companion) are persistence-layer details for recovery replay and
-- archive attribution — they are NOT part of the canonical DTO
-- (CanonicalRuntimeEventV1), which carries only the Notion-locked fields.

CREATE TABLE IF NOT EXISTS runtime_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime_event_id TEXT NOT NULL UNIQUE,
  context_lineage_id TEXT NOT NULL,
  context_seq INTEGER NOT NULL,
  invocation_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN ('user', 'assistant', 'tool_call', 'tool_result', 'body_event', 'operational')
  ),
  origin TEXT NOT NULL,
  payload_schema_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_archive_ref TEXT,
  runtime_session_id TEXT,
  role TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  is_error INTEGER,
  companion TEXT,
  derivation_refs TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE (context_lineage_id, context_seq)
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_lineage_seq
  ON runtime_events (context_lineage_id, context_seq);
CREATE INDEX IF NOT EXISTS idx_runtime_events_session
  ON runtime_events (runtime_session_id);
