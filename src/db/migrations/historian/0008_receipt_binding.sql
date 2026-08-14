-- iris_agent#64 — bind the delivered transition to the EXACT Memory receipt.
--
-- Before this migration, `delivered` was authorized by a bare opaque
-- `delivered_receipt_hash` (0002). A stale/swapped/mismatched receipt could
-- therefore ACK the wrong outbox row. These columns persist the versioned
-- immutable binding identity the Memory contract returns
-- (acceptance-receipt-v1 / duplicate-replay-receipt-v1), so retention/reclaim
-- authorization and audits can verify the receipt belonged to THIS
-- Publication (publication_id), covered THIS canonical payload hash, and was
-- issued under a known contract version.
ALTER TABLE publications ADD COLUMN delivered_receipt_id TEXT;
ALTER TABLE publications ADD COLUMN delivered_receipt_schema_version TEXT;
ALTER TABLE publications ADD COLUMN delivered_receipt_publication_id TEXT;
ALTER TABLE publications ADD COLUMN delivered_canonical_payload_hash TEXT;
ALTER TABLE publications ADD COLUMN delivered_contract_version TEXT;
ALTER TABLE publications ADD COLUMN delivered_duplicate_replay INTEGER NOT NULL DEFAULT 0;
