-- R2: ContextMessageUnit semantic ledger (Roadmap v13 canonical chain).
--
-- RuntimeEvent -> Context ingest -> immutable ContextMessageUnit(contextSeq)
-- -> dual projection (Provider Renderer / ContextHistoryReadPort).
--
-- context.db NEVER stores a second copy of raw Pi messages as raw bytes; the
-- unit payload is the canonical PROVIDER-VISIBLE serialization (the folded
-- input / assistant / tool_result message) — the semantic record the Historian
-- (R3) consumes via ContextHistoryReadPort. The raw archive stays in the Pi
-- Session (bounded).
--
-- context_seq is a per-session monotonic ordinal assigned at Context ingest
-- (NOT the global runtime_events.event_seq). source_event_id UNIQUE enforces
-- exactly-once unit creation per source event (replayable ensureUnitsUpTo).

CREATE TABLE IF NOT EXISTS context_units (
  runtime_session_id TEXT NOT NULL,
  context_seq INTEGER NOT NULL,
  unit_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  unit_type TEXT NOT NULL CHECK (
    unit_type IN ('input', 'assistant', 'tool_result')
  ),
  disposition TEXT NOT NULL DEFAULT 'include' CHECK (
    disposition IN ('include', 'reference_only', 'exclude')
  ),
  entry_id TEXT,
  entry_seq INTEGER,
  content_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  companion_entry_id TEXT,
  pair_key TEXT,
  paired INTEGER NOT NULL DEFAULT 0 CHECK (paired IN (0, 1)),
  derivation_refs TEXT NOT NULL DEFAULT '{"memoryRefs":[],"compartmentIds":[],"sourceContextUnitIds":[]}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (runtime_session_id, context_seq)
);

CREATE INDEX IF NOT EXISTS idx_context_units_session_seq
  ON context_units (runtime_session_id, context_seq);
