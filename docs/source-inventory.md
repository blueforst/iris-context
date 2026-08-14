# iris-context 拆分 —— Source Inventory & 分类基线（Phase A 草稿）

> 权威来源：blueforst/iris-context#1、Notion 规格（/root/dsh-workspace/notion/）、iris_agent 只读审计（/root/dsh-workspace/audit/）。
> 本文件在 Phase A 中持续更新，最终作为 PR 1 的 source baseline 证据。

## 0. 基线 SHA（记录时间 2026-08-14）

| 仓库                   | upstream main                                      | 说明                              |
| ---------------------- | -------------------------------------------------- | --------------------------------- |
| blueforst/iris-context | `19d80c1cec074941205bff5df0f4cd6acc778ade`         | Owner 初始化 README               |
| blueforst/iris_agent   | `82c3f9bc47a8ecd6bc804c256d957397ca073573`         | 拆分来源                          |
| blueforst/iris_memory  | `913dadde61a82c2f7a19caf659ce99c8fd69a112`         | contract 参考（只读）             |
| blueforst/pi           | `edd724be790ec3a73b3a85bb051882a45acc5c72`（seam） | iris_agent 运行时依赖（只读参考） |

依赖版本：

- DSH 0.1.0-rc.6；Cordis 4.0.1（`@deepseek-ai/cordis`）
- Node >=22.19.0、npm、TypeScript 5.9.3、tsx 4.23.1、eslint 9.39.5、prettier 3.9.6
- iris-memory-contracts 0.3.0（pin `b55b5e1c8b022063019ce0bd02c26e184749e600f9c2f0cb6c4e737559fae560`）

## 1. 源文件清单与分类（Context 模块）

| 文件                              | 分类                               | 生产路径       | v27/v29 符合 |
| --------------------------------- | ---------------------------------- | -------------- | ------------ |
| src/context/generation-builder.ts | MOVE_AS_IS                         | 否（需接线）   | ✅           |
| src/context/context-store.ts      | MOVE_AND_REFACTOR                  | ✅             | ⚠️ 部分      |
| src/context/context-ingest.ts     | MOVE_AND_REFACTOR                  | ✅             | ⚠️ 部分      |
| src/context/history-read-port.ts  | MOVE_AND_REFACTOR                  | ✅             | ⚠️ 部分      |
| src/context/context-renderer.ts   | REWRITE                            | ✅             | ❌（m0/m1）  |
| src/context/pass-taxonomy.ts      | DELETE_AS_SUPERSEDED               | ⚠️ 经 renderer | ❌           |
| src/context/carriers.ts           | DELETE_AS_SUPERSEDED               | ⚠️ 常量        | ❌           |
| src/context/pipeline.ts           | DELETE_AS_SUPERSEDED               | 否             | ❌           |
| src/context/projection.ts         | DELETE_AS_SUPERSEDED（类型需迁移） | ⚠️ 类型        | ❌           |
| src/context/lkg.ts                | DELETE_AS_SUPERSEDED               | 否             | ❌           |
| src/context/lkg-units.ts          | DELETE_AS_SUPERSEDED               | 否             | ❌           |
| src/context/protected-tail.ts     | MOVE_AND_REFACTOR                  | 否             | ⚠️ 算法保留  |
| src/context/replay.ts             | MOVE_AND_REFACTOR                  | 否             | ⚠️ 算法保留  |

## 2. 源文件清单与分类（Historian 模块，来自 audit-historian-contracts.md）

| 文件                                   | 分类                 | 生产路径     | 说明                                                 |
| -------------------------------------- | -------------------- | ------------ | ---------------------------------------------------- |
| src/historian/historian-boundary.ts    | MOVE_AS_IS           | ✅           | freeze 纯函数，已 contextSeq 权威化                  |
| src/historian/historian-runner.ts      | MOVE_AS_IS           | ✅           | claim/commit 已 lineage+contextSeq                   |
| src/historian/hot-row-reclaim.ts       | MOVE_AS_IS           | ✅           | 四条件释放                                           |
| src/historian/anti-echo.ts             | MOVE_AND_REFACTOR    | ✅           | EvidenceBasisRef→EvidenceBasisRefV1                  |
| src/historian/compaction-trigger.ts    | MOVE_AND_REFACTOR    | ✅           | 去 m0/m1 措辞，contextSeq 坐标                       |
| src/historian/historian-analysis.ts    | MOVE_AND_REFACTOR    | ✅           | contextSeq 单一坐标                                  |
| src/historian/historian-compartment.ts | MOVE_AND_REFACTOR    | ✅           | lineage-scoped identity + contextSeq 端点            |
| src/historian/historian-manager.ts     | MOVE_AND_REFACTOR    | ⚠️ opt-in    | 删 wrapup 终结器                                     |
| src/historian/historian-queue.ts       | MOVE_AND_REFACTOR    | ✅           | 删 finalizer 语义，保留单 worker 队列                |
| src/historian/historian-store.ts       | MOVE_AND_REFACTOR    | ✅           | 删 snapshot/assessment 表                            |
| src/historian/historian-publication.ts | REWRITE              | ✅           | provider-neutral MemoryObservation/MemoryPublication |
| src/historian/historian-continuity.ts  | DELETE_AS_SUPERSEDED | ⚠️           | v27 废止（ContinuitySnapshot/wrapup/overlap）        |
| src/historian/historian-assessment.ts  | DELETE_AS_SUPERSEDED | ⚠️           | v26 废止（MemoryAssessmentDelta）                    |
| src/historian/history-read-port.ts     | KEEP_RUNTIME_ADAPTER | 否（仅测试） | recovery/audit，Pi 耦合，留 iris_agent               |
| src/historian/memory-client.ts         | KEEP_RUNTIME_ADAPTER | ✅           | Memory Service Adapter（投递桥）                     |

## 3. Contracts 单一权威（来自 audit-historian-contracts.md §4）

- `src/contracts/context-v27.ts`：当前 Context V2 单一机器权威（手写 TS），随 iris-context 迁移 MOVE_AS_IS；含 ContextMessageUnitV1/ContextUnitV2/ContextGenerationV2/校验器/哈希/V1→V2 fence。
- `src/contracts/context-units.ts`：legacy `ContextMessageUnit`（payload: AgentMessage）→ DELETE_AS_SUPERSEDED。
- `src/contracts/context.ts`：含 carrier/m0/m1 残留 → MOVE_AND_REFACTOR（删除废止概念）。
- `src/contracts/historian.ts`：HistorianBatchV1 形状不合规 + Session 端口 → REWRITE（对齐权威 schema）。
- `src/contracts/runtime-events.ts`：旧 R1 形状，无 CanonicalRuntimeEventV1 → MOVE_AND_REFACTOR。
- 缺失：HistorianCommitReceiptV1、ContextHistoryReadPortV1.freezeBatch、ContextRetirementPortV1、EvidenceBasisRefV1、OriginEnvelopeV1 schemaId。
- 无 codegen；@iris/agent-contracts 生成包不存在 → iris-context 需新建（Phase B）。

## 4. Migrations 归属

| 目录                                      | 归属                                    | 说明                                                                                       |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| src/db/migrations/context/（0001–0007）   | → iris-context                          | context.db（0004 identity lineage 关键迁移；0005 两个同名需重编号）                        |
| src/db/migrations/historian/（0001–0010） | → iris-context                          | historian.db（删除 continuity_snapshots/memory_assessment_deltas；0005/0008 同名需重编号） |
| src/db/migrations/runtime-events/         | → iris-context（裁决：随 Context 迁移） | 与 context_units 同事务语义                                                                |
| src/db/migrations/agent/                  | 留 iris_agent                           | recovery 等                                                                                |
| src/db/migrations/ingress/                | 留 iris_agent                           | ingress acceptances                                                                        |
| src/db/migrations/runtime-epochs/         | 留 iris_agent                           | 删 continuity_snapshot_id 字段                                                             |

migrate.ts 机制：forward-only + checksum + newer-schema fail-closed + 每文件事务 + WAL/FK。

## 5. 测试矩阵（随模块迁移）

- Historian：historian-b1..b12、r3-exit-gate、r3-reclaim、r4-memory-client、anti-echo、history-read-port、migration-receipt-binding、xrepo-receipt-binding（b6 continuity / b7 assessment 随废止对象删除或改写）。
- Context：context-store、context-bounded、context-fail-closed、context-ingest、context-v2-contract、context-v2-fail-closed-boundary、context-durable-contract-authority、context-golden、context-protected-tail、context-replay、historical-lineage-recovery、rollover（部分）、receipt-crash-consistency、m0m1-parity-golden（v29 过时，删除）、context-carriers/pass-taxonomy/pipeline/projection/lkg（v29 过时，删除）。
- Contract/Migration：migration、contracts、memory-contract-gate、memory-contracts-pin、production-lock（留 iris_agent 部分）。

## 5b. iris_memory 结论（来自 audit-iris-memory.md）

- **拆分不要求修改 iris_memory**；iris-context 继续消费 `iris-memory-contracts@0.3.0`（pin b55b5e1c…）。
- iris_memory 仍 Graphiti-shaped（historian-publication:v3 + graphiti-episode-source:v2），作为 backend wire 可保留；provider-neutral 是 iris-context 侧 authoring 设计 + 未来中央 contracts registry 项。

## 6. context.db 物理表（来自 audit-context.md）

| 表                             | owner                      | 状态                      |
| ------------------------------ | -------------------------- | ------------------------- |
| context_lineages               | ContextStore               | ⚠️ 含 superseded 列       |
| context_units                  | ContextStore/ContextIngest | ✅ 核心（需升级 V1 字段） |
| context_deferred_operations    | —                          | ❌ 死表                   |
| context_lkg_slots              | —                          | ❌ 死表                   |
| session_lineage_bindings       | ContextStore               | ✅ 核心                   |
| session_lineage_bindings_audit | ContextStore               | ✅ 核心                   |
| schema_migrations              | migrateDatabase            | ✅ 基础设施               |

规格目标表未实现：context_meta、context_unit_payloads、raw_archive_refs、context_unit_compartment_bindings、historian_claims、historian_receipts、context_watermarks、bust_requests、bust_receipts、operational_fences。

## 7. 生产调用链（现状）

```
host/composition.ts → vertical-slice.ts
  ├─ ContextStore.open(context.db)
  ├─ ContextIngest(ledger, store) → runtime-event-seam → ensureUnitsUpTo
  ├─ ContextRenderer(store) → harness-factory contextController → renderForProviderCall(m0/m1) → persistRender
  ├─ createContextHistoryReadPort(store) → HistorianManager.claimHistorianBatch
  └─ Pi Runtime Capsule（Session/Harness）
```

## 8. 历史提取方案

git-filter-repo 从 iris_agent（base `82c3f9bc`，317 commits）提取相关路径（src/context、src/historian、src/contracts、根级 contracts（单一机器权威 + codegen 生成物）、src/db/migrations/context、src/db/migrations/historian、src/db/migrations/runtime-events、test、fixtures、scripts、docs、.github 等），实测 **277 commits / 402 files** 完整保留文件历史（与 docs/history-extraction.md 一致）。提取结果已作为 merge commit 并入 iris-context 分支历史（提取历史 tip 为 `<extracted-tip>`，`git rev-list --count <extracted-tip>` = 277）；后续各 Phase 从该历史恢复对应文件并重构。初版提取曾误基于 `6702e61`（248 commits）并经复审修正为 `82c3f9bc`；路径清单随后补充根级 `contracts/`（276→277 commits），详见 docs/history-extraction.md 修正记录。

## 9. 禁止泄漏清单（iris-context 生产包）

- Pi（@earendil-works/pi-*）：禁止
- Graphiti SDK / Neo4j：禁止
- iris_memory Python 实现：禁止（仅消费版本化 contract 工件 0.3.0）
- m0/m1/carrier/LKG/SOFT/HARD/pass taxonomy/ContextSourceSnapshot/prepareInvocationSources/transformMessages/ContinuitySnapshot：禁止
