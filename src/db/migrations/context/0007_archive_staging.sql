-- iris_agent#74: binding audit STAGING marker. Reclaimed binding rows are
-- copied to session_lineage_bindings_audit (provenance never lost), then
-- staged (archived_batch_id assigned) and moved OUT of the active
-- context.db into the EXTERNAL archive (context-archive.db) by
-- archiveBindingAudit(). The active audit table therefore only ever holds
-- the in-flight staging window (bounded by the archive sweep), never a
-- lifetime archive — active context.db stays bounded in rows AND bytes
-- under long-running rollover operation.
ALTER TABLE session_lineage_bindings_audit ADD COLUMN archived_batch_id INTEGER;

-- Staging scan + delete-by-batch both filter on the marker.
CREATE INDEX IF NOT EXISTS idx_session_lineage_bindings_audit_staged
  ON session_lineage_bindings_audit(archived_batch_id, pruned_at);
