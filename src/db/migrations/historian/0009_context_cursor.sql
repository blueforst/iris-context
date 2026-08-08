-- iris_agent#76: the Historian's AUTHORITATIVE durable cursor moves to
-- Context semantic coordinates (lineage + global contextSeq).
-- processed_through_context_seq: highest committed contextSeq (exclusive
-- cursor: next eligible batch starts at +1). NULL on legacy rows = nothing
-- processed yet (the runner treats NULL as 0).
-- observed_head_context_seq: frozen head in Context coordinates
-- (attribution).
ALTER TABLE session_state ADD COLUMN processed_through_context_seq INTEGER;
ALTER TABLE session_state ADD COLUMN observed_head_context_seq INTEGER;
-- Boundary snapshots carry the same Context coordinates (batch identity +
-- head) alongside the raw attribution.
ALTER TABLE boundary_snapshots ADD COLUMN lineage_id TEXT NOT NULL DEFAULT '';
ALTER TABLE boundary_snapshots ADD COLUMN observed_head_context_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE boundary_snapshots ADD COLUMN eligible_through_context_seq INTEGER NOT NULL DEFAULT 0;
