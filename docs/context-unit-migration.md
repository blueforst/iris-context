# ContextUnit 单类型迁移设计（iris-context#2 / DSH Context vertical slice）

- 状态：设计锁定（Feature 1 基线；字段名以本文件 + 生成 registry 为准）
- 覆盖范围：iris-context#2 的 single `ContextUnit` lifecycle 迁移
- 冲突优先级：2026-08-15 Notion override > iris-context#2 > 现有实现 > 旧 Issue #1 措辞 > 历史测试

## 1. 目标模型

任何内容一旦被 Context 接纳，物化为 `ContextUnit` **exactly once**；从接纳到离开
Context 生命周期，identity 与领域类型保持不变。禁止 `ContextMessageUnit → ContextUnitV2`
双 DTO 链；禁止 `LedgerUnit → LiveUnit → FrameItem` 换型；禁止把 lifecycle/选择/表示状态
写回 Unit 内容。

```text
semantic source
→ Context admission
→ ContextUnit（同一类型贯穿 持久化/选择/Historian/representation/retirement）
→ 离开 Context 生命周期
```

类型名不带 `V1/V2`；wire/storage 版本只由 `schemaId` 表达。旧历史已真实使用
`iris.context_unit.v1`（flat legacy）与 `iris.context_unit.v2`（structured generation
member），因此新统一 ContextUnit 分配新 schema 身份 **`iris.context_unit.v3`**
（registry/history 已核实，见 docs/context-unit-migration.md §5）。

## 2. ContextUnit 本体（新 schema `iris.context_unit.v3`）

```typescript
interface ContextUnit {
  schemaId: "iris.context_unit.v3"; // wire/storage 版本；领域类型名 = ContextUnit
  unitId: string; // 稳定 identity（contextId 内唯一）
  contextId: string; // = contextLineageId（identity 级，one per data root）
  contentSchemaId: string; // 语义类型判别器（iris.semantic.*，无第二套 type/kind 字段）
  content: JsonValue; // canonical content：Context 接纳时确定的 provider-neutral 规范内容
  contentHash: string; // canonical content 完整性 hash
  sourceRef: ContextUnitSourceRef; // immutable origin/source identity
  derivation?: SemanticDerivationRefsV1; // 仅当确实属于 immutable source/basis 时存在
}
```

- `content` 在 Unit 生命周期内不可原地修改；语义变化 → 新 ContextUnit。
- `contentHash` = `sha256(canonicalJson({schemaId, unitId, contextId, contentSchemaId,
content, sourceRef, derivation?}))`（覆盖全部 immutable 字段，排除 hash 自身）。
- `ContextUnitSourceRef` 是判别联合：
  - `ContextUnitSourceRefV1`（`iris.context_unit_source_ref.v1`，既有稳定 schema 复用）：
    `{ sourceSchemaId, sourceId, sourceRevision?, sourceHash }` —— P0–P4 / 派生 Unit 的通用
    source identity；
  - `DshMessageRefV1`（新 schema `iris.dsh_message_ref.v1`）：
    `{ sessionId, messageId, eventSeq?, sourceHash? }` —— runtime-origin P5 的原始事实来源。
- `derivation` 复用既有 `iris.semantic_derivation_refs.v1` schema（immutable basis refs）。
  新模型正常路径只使用 `memoryRefs` / `sourceContextMessageUnitIds`（派生 basis）；
  `compartmentIds` / `workSnapshotVersion` 属于生命周期处境 → sidecar，不进 Unit。

## 3. 必须移出 ContextUnit 的状态（sidecar / index / binding）

| 状态                                             | 载体                                                          |
| ------------------------------------------------ | ------------------------------------------------------------- |
| accepted ordering `contextSeq`                   | context_units.context_seq（保留；Historian 轴心）             |
| `kind`（user/assistant/tool_result）             | 物理列（admission 时由 contentSchemaId 派生；P0–P4 无 kind）  |
| Historian disposition / claim / cursor / receipt | context_units.disposition + historian.db 既有表               |
| lifecycle_state（committed/…/retired）           | context_units.lifecycle_state                                 |
| P5 membership / 当前 P-level / 数组 index        | 派生（disposition+lifecycle+represented watermark），不落新表 |
| represented-by / Compartment binding             | context_unit 侧 companion 列 / historian 绑定（既有机制）     |
| retirement / payload GC                          | context_units.retired_through / payload_reclaimed_at（既有）  |
| archive 冷热位置 / blob placement                | 不进 Unit（既有的 raw_archive_ref 降级为 legacy）             |
| current generation/frame identity                | 不落 Unit                                                     |

## 4. 旧 bridge schema 逐项裁决（含真实 call-chain 证据）

审计依据：audit/historian-consumers-audit.md、audit/migrations-audit.md。

| 概念                                            | 当前职责（证据）                                                                                                                                                                                                                                                        | 裁决                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `contextSeq`                                    | Historian cursor（historian-store lineage_cursors）、claim 锚定（historian-runner:88-95）、receipt 闭区间（historian.ts:90-103）、Compartment/Publication provenance、rangeHash（historian.ts:39-54）、compaction（compaction-trigger）、ACK 回写（context-store:2513） | **保留**为 accepted ordering sidecar（context_seq 列），不改名、不换序                                                    |
| `runtimeEventId`                                | runtime_events 主键 + context_units 列 + rowToUnit 反序列化 + Recovery 对账                                                                                                                                                                                             | **降级**：DSH 正常路径不再生成；runtime_events 表保留为 legacy/审计，新行 sourceRef=DshMessageRef                         |
| `CanonicalRuntimeEvent` / runtime_events ledger | RuntimeEventIngestPort + ContextIngest 原子 ingest                                                                                                                                                                                                                      | **退出正常路径**：DSH Session 是 raw truth；runtime_events 表不再写入（保留旧行）。RuntimeEvent 概念仅在 legacy/migration |
| `RawArchiveRefV1`                               | context_units.raw_archive_ref + parseStoredRawArchiveRef                                                                                                                                                                                                                | **降级**：DSH 路径由 DshMessageRef 覆盖（sessionId+messageId+eventSeq+sourceHash）；raw_archive_ref 保留为 legacy 列      |
| companion / pairKey / CompanionPayloadV1        | runtime_events.companion + context_units 配对列 + foldUserPayload                                                                                                                                                                                                       | **退出 DSH 正常路径**：DSH Message 有稳定 identity/source，无需 Pi 式 hidden companion；配对列保留为 legacy 兼容          |
| `ContextMessageUnitV1`                          | durable ledger DTO（ingest/store/historian 输入）                                                                                                                                                                                                                       | **退出正常路径**：仅 legacy/migration/compat fixture 可见                                                                 |

## 5. schema 历史与 `iris.context_unit.v3` 决策

- `iris.context_unit.v1`：flat legacy 单元，历史使用（migration-fixtures/v1-flat-unit 等），
  当前 registry 无此 schema，仅 fixture。
- `iris.context_unit.v2`：当前 structured generation member（registry schemas）。
- 因 v1/v2 均已被历史真实使用，新统一 ContextUnit 分配 **`iris.context_unit.v3`**。
- `iris.context_generation.v2` 的 units 成员类型将改为 ContextUnit(v3)，属 breaking wire
  变化 → 新 generation schema **`iris.context_generation.v3`**（header 复用
  `iris.context_generation_header.v1`，形状不变）。
- `iris.context_unit_source_ref.v1`（通用 source ref 形状）复用；新增
  `iris.dsh_message_ref.v1`。
- `iris.semantic_derivation_refs.v1` 复用。

## 6. OLD FIELD → NEW 映射表（persistence，自审前置）

来源：audit/migrations-audit.md §6.1（context_units 0012 后物理形态）。

| OLD 物理列（context_units）            | NEW ContextUnit 字段                                    | sidecar 状态                      | compatibility-only                 | DELETE                 |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------- | ---------------------------------- | ---------------------- |
| context_lineage_id                     | → contextId（DTO 边界）                                 | context_lineage_id 列保留         | —                                  | —                      |
| context_seq                            | —                                                       | **保留原值**（accepted ordering） | —                                  | —                      |
| unit_id                                | → unitId                                                | —                                 | —                                  | —                      |
| semantic_schema_id                     | → contentSchemaId                                       | 列保留（读时映射）                | —                                  | —                      |
| payload                                | → content                                               | —                                 | —                                  | —                      |
| content_hash                           | → contentHash                                           | 列保留（v3 basis 重算）           | —                                  | —                      |
| derivation_refs                        | → derivation                                            | —                                 | 旧键 sourceContextUnitIds 读迁移   | —                      |
| —（新）source_ref                      | → sourceRef                                             | —                                 | —                                  | —                      |
| —（新）unit_schema_id                  | → schemaId 物理标记                                     | —                                 | —                                  | —                      |
| runtime_event_id                       | —                                                       | —                                 | 保留（legacy 溯源）                | 新行不再写             |
| source_event_id                        | —                                                       | —                                 | 保留（legacy exactly-once 锚）     | 新行不再写             |
| unit_type                              | —                                                       | → kind 派生（contentSchemaId）    | 保留（legacy CHECK）               | 新行可为 NULL          |
| disposition                            | —                                                       | sidecar（historian disposition）  | —                                  | —                      |
| lifecycle_state                        | —                                                       | sidecar（生命周期）               | —                                  | —                      |
| entry_id / entry_seq                   | —                                                       | —                                 | 保留（Pi 窄归档映射）              | 新行不再写             |
| companion_entry_id / pair_key / paired | —                                                       | —                                 | 保留（Pi companion）               | 新行不再写             |
| schema_version                         | —                                                       | —                                 | 保留（'context-unit-v1' 物理标签） | 新行 'context-unit-v3' |
| raw_archive_ref                        | —                                                       | —                                 | 保留（Pi archive 溯源）            | 新行由 sourceRef 覆盖  |
| content_hash_basis                     | —                                                       | 扩展 'v3'（新 hash basis）        | 'v1'/'v2' 保留                     | —                      |
| legacy_status                          | —                                                       | —                                 | 保留（quarantined 行不迁移）       | —                      |
| payload_reclaimed_at                   | —                                                       | sidecar（GC marker）              | —                                  | —                      |
| created_at                             | —（admission 时间不入 Unit；若需要可由 admission 记录） | sidecar 保留                      | —                                  | —                      |

迁移原则（forward-only）：

1. 旧 migration 文件 checksum-pinned，不可修改。
2. 新列一律 `ALTER TABLE ... ADD COLUMN` + 确定性回填；CHECK 变化走 SQLite 表重建
   （historian 0012 模式）。
3. `legacy_status='quarantined_legacy'`（content_hash_basis='v1'）行**不迁移**为 current
   unit（已物理隔离，读路径 fail-closed）。
4. `content_hash_basis='v2'` 的既有行：可确定性迁移为 v3（按新 hash basis 重算；内容、
   identity、contextSeq 原值保留），或保留为 legacy 可读。二选一在 Feature 2 中实现。
5. payload 已回收行：只映射为 cold-migration marker，不还原 payload。

## 7. 生产调用链改造面（Feature 2–5）

见 audit/historian-consumers-audit.md §8 与本文 Feature 划分。核心：Historian batch 的
units 携带 ContextUnit + 必需的 sidecar 坐标（contextSeq/kind/disposition/derivation），
通过**同一个 ContextUnit**（同一 unitId/type）贯穿，不复制内容到第二 DTO。

## 8. Feature 划分（独立 review 门）

- Feature 1：ContextUnit + SourceRef + DshMessageRef + schema migration design（新 schema
  身份 v3；不改生产路径）。
- Feature 2：single ContextUnit persistence + 旧 schema migration（context_units 新列 +
  v3 hash basis + admission 持久化；移除 ContextMessageUnit 正常 durable 路径）。
- Feature 3：current Context assembly 直接 ContextUnit[]（generation v3；移除
  projectP5Unit 投影）。
- Feature 4：DSH MessageRef ingress（admitRuntimeMessage；移除 Pi companion 正常路径）。
- Feature 5：Historian / P3 / P4 / retirement 全部迁移为同一 ContextUnit。
- Feature 6：Cordis 公共 API + iris_agent consumer + legacy fence + cleanup。
