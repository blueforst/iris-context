-- R4 (iris_agent#9) — outbox carries the full publication payload.
--
-- Memory Client 投递时需要完整的 HistorianPublication envelope(v2,
-- 含 evidenceBasis/derivedOnly)。此前 outbox 只存 payload_hash,投递端
-- 无法重建 payload;本 migration 增加 payload_json,由 commitSafePrefix
-- 在事务内写入(与 cursor/publication/outbox 行原子)。
ALTER TABLE publication_outbox ADD COLUMN payload_json TEXT;
