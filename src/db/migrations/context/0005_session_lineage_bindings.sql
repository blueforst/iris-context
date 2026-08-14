-- iris_agent#52: append-only, data-root-local ledger of Runtime Session ->
-- Context lineage bindings. Every binding ever created stays here; rollover
-- marks the superseded current binding as historical instead of deleting it,
-- so the Recovery Reconciler can resolve a verified old Session to its durable
-- identity lineage after rollover. Normal production ingest still resolves
-- ONLY through context_lineages.current_runtime_session_id (fail closed);
-- this table is exclusively the reconciliation/audit authority.
--
-- Forward-only invariant: rows are never deleted. binding_role transitions
-- 'current' -> 'historical' via superseded_at.
CREATE TABLE IF NOT EXISTS session_lineage_bindings (
	runtime_session_id TEXT NOT NULL,
	context_lineage_id TEXT NOT NULL,
	binding_role TEXT NOT NULL CHECK (binding_role IN ('current', 'historical')),
	bound_at TEXT NOT NULL,
	superseded_at TEXT,
	-- sha256(runtimeSessionId + ":" + contextLineageId); integrity gate for
	-- reconciliation reads (a fabricated/corrupted binding row fails closed).
	binding_checksum TEXT NOT NULL,
	PRIMARY KEY (runtime_session_id, context_lineage_id)
);

CREATE INDEX IF NOT EXISTS idx_session_lineage_bindings_lineage_role
	ON session_lineage_bindings(context_lineage_id, binding_role);
