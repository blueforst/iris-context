-- iris_agent#65: durable retry/exhaustion state for finalizers.
--
-- The in-memory HistorianQueue tracks attempts only on the HistorianJob;
-- when maxAttempts is exhausted the worker counts a permanent failure and
-- clears the running job, but the durable session_state stays 'closing' and
-- the next refill() re-admits a brand-new attempt=0 finalizer — a
-- permanently failing finalizer can therefore cycle forever, making
-- maxAttempts a non-durable retry bound.
--
-- This migration adds the durable retry ledger:
--   retry_attempts      : how many failed attempts the finalizer has used
--                         (persisted on every requeue, survives restart)
--   retry_exhausted_at  : set ONCE when maxAttempts is reached. Refill and
--                         startup recovery skip exhausted sessions; only an
--                         explicit operator/manual reactivation clears it.
--
-- Forward-only. NULL retry_exhausted_at = still retryable.
ALTER TABLE session_state ADD COLUMN retry_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_state ADD COLUMN retry_exhausted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_session_state_retry_exhausted
  ON session_state(retry_exhausted_at);
