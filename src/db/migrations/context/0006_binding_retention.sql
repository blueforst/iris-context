-- iris_agent#63: bounded historical Session->lineage binding ledger.
--
-- Roadmap v13 requires context.db to be a bounded ACTIVE semantic authority,
-- not a store that grows linearly with Iris lifetime. The pre-#63 invariant
-- was "rows are never deleted": every Runtime Session rollover appended
-- another historical binding forever.
--
-- This migration introduces the authoritative-evidence-based retention
-- model (no wall-clock guessing):
--
--   1. reconciled_at TEXT  — set by the Recovery Reconciler AFTER it has
--      proven the Session has no pending Pi receipt / reconciliation need
--      (its receipt window is fully consumed). A binding WITHOUT this
--      marker can still be required to reconcile a
--      Session-committed/Iris-uncommitted window and is NEVER reclaimable.
--
--   2. session_lineage_bindings_audit — append-only audit provenance for
--      pruned bindings. Reclaim copies the row here BEFORE deleting it from
--      the active ledger, so removing a historical binding from active
--      context.db never loses audit provenance (which session was bound to
--      which lineage, when, and with which checksum).
--
--   3. Retention policy (implemented in ContextStore, documented here):
--        SOFT_LIMIT    = 4096 historical bindings  -> automatic reclaim of
--                         reconciled bindings outside the retain window
--        HARD_LIMIT    = 16384 historical bindings -> bindCurrentSession /
--                         createLineage fail closed with a typed error when
--                         even automatic reclaim cannot bring the ledger
--                         under the hard limit (all historical bindings
--                         still in a recoverable window)
--        RETAIN_RECENT = 64 recent historical bindings kept regardless of
--                         reconciled_at (audit checkpoint / late-recovery
--                         margin; the newest bindings are the most likely
--                         to still be needed by an in-flight rollover)
--
--   4. Fail-closed resolution: a pruned binding resolves exactly like an
--      unknown/foreign one — resolveLineageForRecovery throws its typed
--      "no binding" error; no old Session can become current again.
--
-- Forward-only. reconciled_at is set ONCE and never cleared by reclaim.
ALTER TABLE session_lineage_bindings ADD COLUMN reconciled_at TEXT;

CREATE TABLE IF NOT EXISTS session_lineage_bindings_audit (
  runtime_session_id TEXT NOT NULL,
  context_lineage_id TEXT NOT NULL,
  binding_role TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  superseded_at TEXT,
  binding_checksum TEXT NOT NULL,
  reconciled_at TEXT,
  pruned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_lineage_bindings_audit_pruned
  ON session_lineage_bindings_audit(pruned_at);
