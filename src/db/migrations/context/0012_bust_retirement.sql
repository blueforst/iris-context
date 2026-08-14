-- Phase E（canonical BUST full rebuild）：retired watermark + generation
-- binding + payload cold-migration marker。
--
-- v27–v29 权威约束（Context Assembly / Bounded context.db / Bust-driven
-- Retirement Override）：
--   * represented/retired watermark 只能在 successful canonical BUST
--     full-rebuild 的原子发布事务内推进；BUST 失败 fail-closed，绝不推进；
--   * markRepresentedAndRetired 绑定新发布的 contextGenerationId +
--     contextGenerationHash（bounded audit；不持久化可重放的旧 generation）；
--   * 逻辑退休后，GC 只回收 retired 单元的 semantic payload（保留
--     identity/hash/binding/disposition/archive locator）。
--
-- 1) context_lineages：
--      retired_through_context_seq    retired watermark（contextSeq 坐标；
--                                     单调只进不退，默认 0 = 尚未退休任何单元）；
--      last_bust_generation_id       最近一次成功 BUST 原子发布绑定的 generation id；
--      last_bust_generation_hash     同一发布的 generation hash（audit 绑定）；
--      last_bust_at                   该发布时刻（audit）。
-- 2) context_units：
--      payload_reclaimed_at           semantic payload 冷迁移标记（NULL =
--                                     payload 完整；非 NULL = 已 GC/冷迁移）。
--                                     reclaimed 行只可能是 lifecycle_state=
--                                     'retired'（读路径 fail-closed 断言）。
ALTER TABLE context_lineages
  ADD COLUMN retired_through_context_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE context_lineages
  ADD COLUMN last_bust_generation_id TEXT;

ALTER TABLE context_lineages
  ADD COLUMN last_bust_generation_hash TEXT;

ALTER TABLE context_lineages
  ADD COLUMN last_bust_at TEXT;

ALTER TABLE context_units
  ADD COLUMN payload_reclaimed_at TEXT;
