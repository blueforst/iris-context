-- R2-P1: represented-through watermark in ContextMessageUnit context_seq space.
--
-- v12 的 represented_through_entry_seq 是 Session entrySeq 空间（session 本地）。
-- R2 的 canonical chain 从 immutable ContextMessageUnit 渲染（context_seq 每
-- session 单调），因此 Provider Renderer 需要一个独立的 context_seq 空间
-- watermark。0003 只做 forward-only 加列：默认 0 = 尚未表示任何单元，与全新
-- lineage 语义一致。migrateDatabase 对每个文件做 sha256 checksum，已应用的
-- 文件不允许变更。
ALTER TABLE context_lineages
  ADD COLUMN represented_through_context_seq INTEGER NOT NULL DEFAULT 0;
