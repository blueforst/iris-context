-- R3 (iris_agent#9) — archive shards & hot-row reclaim (Exit Gate 4).
--
-- active historian.db 的有界性:compartments/segments/evidence_sets/
-- attribution_manifests/boundary_snapshots 行在满足四条件后才从 hot 区
-- 释放(物理删除),释放前先 seal 成不可变 archive shard(带 sha256 + catalog)。
--
-- 四条件(全部满足才释放):
--   1. context_ack           : Context 侧已确认该范围(ACK 记录)
--   2. bust_represented      : Context bust 已表示该范围(compartment 已被
--                              SOFT/HARD bust retirement 覆盖)
--   3. memory_durable_ack    : iris_memory 已 durable 接受对应 Publication
--                              (durable receipt hash 已记录)
--   4. shard_verified        : archive shard 文件 seal hash 已验证
--
-- 跨库规则:historian.db 只记录 ACK 的 VALUE(范围 seq/hash/receipt hash),
-- 不持有 context.db / iris_memory 的句柄或外键。Context ACK 由 Agent
-- 编排层写入;memory durable ACK 由 outbox delivered 回调写入。

-- 每个 compartment 的释放条件跟踪(一行一个 compartment)。
CREATE TABLE IF NOT EXISTS compartment_release_state (
  compartment_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  compartment_sequence INTEGER NOT NULL,
  start_entry_seq INTEGER NOT NULL,
  end_entry_seq INTEGER NOT NULL,
  publication_sequence INTEGER,
  -- 条件 1:Context 侧 ACK(编排层在 Context bust/retirement 后写入)。
  context_acked_at TEXT,
  -- 条件 2:bust represented(compartment 已被 bust retirement 覆盖)。
  bust_represented_at TEXT,
  -- 条件 3:memory durable ACK(iris_memory acceptance receipt hash)。
  memory_durable_ack_at TEXT,
  memory_receipt_hash TEXT,
  -- 条件 4:archive shard seal 验证。
  shard_id TEXT,
  shard_verified_at TEXT,
  -- 释放完成(行已从 hot 表删除,仅留 catalog 痕迹)。
  reclaimed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (runtime_session_id, compartment_sequence)
);

-- 不可变 archive shard catalog(seal 后只读)。
CREATE TABLE IF NOT EXISTS archive_shards (
  shard_id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL,
  first_compartment_sequence INTEGER NOT NULL,
  last_compartment_sequence INTEGER NOT NULL,
  shard_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  sealed_at TEXT NOT NULL,
  UNIQUE (runtime_session_id, first_compartment_sequence)
);

CREATE INDEX IF NOT EXISTS idx_release_state_pending
  ON compartment_release_state(runtime_session_id, compartment_sequence);
CREATE INDEX IF NOT EXISTS idx_archive_shards_session
  ON archive_shards(runtime_session_id, first_compartment_sequence);
