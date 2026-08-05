# R3 之后的排除单元回收（follow-up，不在 R3 范围内）

## 背景：R2-P3 排除单元（excluded units）

R2-P3 为 ContextStore 引入了每 Session 软 cap（`maxUnitsPerSession`，缺省
`MAX_UNITS_PER_SESSION`）。当某 Session 的 `context_units` 行数（含已排除行）达到
软 cap 后，新写入的单元以 `disposition="exclude"` 落库（`context-store.ts`
`ensureUnitsUpTo` / `insertUnit` 的软 cap 分支）。语义：

- **R3 不可见**：`ContextStore.listUnits` 默认只返回 `disposition="include"` 的单元
  （store 级过滤），provider 视图（`renderForProviderCall` / `rebuildM0Body` /
  `renderHistorySince`）与整个 R3 Context 消费链都看不到 excluded 单元；
- **物理保留**：`context_units` 是 append-only——行永不物理删除，只改 disposition
  标记。软 cap 判定以全部行数（含 excluded）为基准（`countUnits`）；
- **R3 Historian 裁剪候选**：R2-P3 注释明确 excluded 单元"作为 R3 Historian 的
  裁剪候选"——即历史压力下的候选回收对象（见 `context-store.ts` 模块头注释）。

## 为什么不在 R3 内回收

1. **历史安全条件未满足**：excluded 单元是尚未被任何语义处理（compartment /
   publication）完全承接的原始语义单元。删除它们必须以"其所在 compartment 已被
   publication 覆盖并归档（含 continuity snapshot / outbox 投递完成）"为前提，
   否则会破坏 Historian 的 evidence 可审计性与跨 Session 连续性；
2. **R3 的权威状态是"不可见但保留"**：listUnits 默认过滤已经保证 excluded 单元
   不泄漏进任何 provider 可见输出；物理删除是纯存储回收优化，不改变 R3 语义；
3. **跨项目边界**：context.db 由 Context 模块权威持有（AGENTS.md 单一 owner），
   回收需要 Context 模块自身的生命周期钩子（如 compartment 归档确认），不能在
   R3 工作项里仓促引入。

## 后续回收方案（post-R3 follow-up 候选）

- 时机：在覆盖该 excluded 单元的 compartment 已发布（publication + outbox
  到达 delivered）且对应 continuity snapshot 已归档之后；
- 条件：`DELETE FROM context_units WHERE disposition='exclude' AND <安全条件>`，
  与 Context 模块的归档确认回调联动，保持 append-only 不变量在删除语义下的
  一致性（删除是显式、有据可查的回收，而非隐式覆盖）；
- 验收：删除后 `listUnits`（默认 include 过滤）输出不变；reindex / replay
  不依赖被删行；删除必须可审计（记录 entry_seq 范围）。

**状态：明确不包含在 R3 交付内，无代码变更。** 本文件仅记录事实与后续方向。
