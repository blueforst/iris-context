-- R3 Historian (issue #8 Phase B, Feature B5 review): persist the Router
-- ACK receipt so the delivered transition has an audit trail.
ALTER TABLE publications ADD COLUMN delivered_receipt_hash TEXT;
