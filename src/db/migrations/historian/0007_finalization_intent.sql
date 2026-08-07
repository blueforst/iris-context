-- iris_agent#53: durable finalization intent timestamp.
--
-- The in-memory scheduler is strictly bounded: when the queue is full of
-- finalization intents there is nowhere to admit a new one WITHOUT growing
-- memory. The authoritative closing/finalization intent lives here (it
-- already did — status='closing' is durable); this migration adds the intent
-- timestamp so readiness can expose the oldest pending finalization age and
-- the durable-backlog refill can be fair and deterministic
-- (FIFO by finalization_requested_at).
--
-- Forward-only. finalization_requested_at is set ONCE when a session enters
-- 'closing' (idempotent); it is never reset by re-enqueues or recovery.
ALTER TABLE session_state ADD COLUMN finalization_requested_at TEXT;

UPDATE session_state
SET finalization_requested_at = updated_at
WHERE status = 'closing' AND finalization_requested_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_session_state_closing_intent
	ON session_state(status, finalization_requested_at);
