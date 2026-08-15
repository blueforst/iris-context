# iris-context

Iris 的 **Context + Historian** 领域插件仓库。本仓库统一拥有 Context 与 Historian 的领域实现、`context.db` 与 `historian.db` 的 schema/migration、P0–P5 `ContextGenerationV2`、canonical BUST、provider-neutral Memory Publication authoring，并通过 DSH/Cordis 挂载为带 `iris` 前缀的 typed services。

本仓库从 `blueforst/iris_agent` 拆出（历史经 git-filter-repo 保留，见 [`docs/history-extraction.md`](docs/history-extraction.md)）。任务与审查工作队列见 [blueforst/iris-context#1](https://github.com/blueforst/iris-context/issues/1)。

## 领域边界

本仓库拥有：

- Context 语义 ledger：`ContextMessageUnitV1`、`contextLineageId/contextSeq`、canonical RuntimeEvent 归一化；
- `context.db`（durable canonical state、payload 生命周期、watermarks、BUST 审计、operational fences）；
- Historian：batch/claim/lease/receipt、Compartment、anti-echo、provider-neutral `MemoryObservation/MemoryPublication` authoring、outbox/archive；
- `historian.db`；
- P0–P5 `ContextGenerationV2 { header, units }` 的 deterministic projection、validation、hashing（仅驻内存）；
- 唯一 canonical BUST coordinator（P4 只在此更新）；
- representation/retirement/GC（只有成功 BUST 推进 watermarks）；
- Context/Historian migrations；
- Cordis services、source contribution seam、Historian semantic adapter seam（ownership-scoped、frozen profile）；
- testkit、fixtures、benchmark。

本仓库不拥有 / 不依赖：

- Pi Agent Loop、Pi Session repository、Pi `AgentMessage`/`CustomMessage` 作为公共契约；
- Graphiti SDK、Neo4j、Graphiti-shaped DTO；
- provider renderer、Tool execution、Memory Service transport 实现；
- Host/CLI/Web、Persona/Work/Body 权威 repository；
- 第二套 Plugin Manager / DI / hook bus / lifecycle；
- 已废止概念（m0/m1、LKG、SOFT/HARD、pass taxonomy、carrier、provider delta、invocation-local overlay、ContinuitySnapshot）。

## 状态

本仓库处于拆分实施中（`extract-context-module` 分支，Phase A–H，见 Issue #1）。当前基线：审计与历史提取完成、仓库骨架就绪；contracts/领域核心将在 Phase B 起逐步落地。

## 开发

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run check:codegen-freshness
```

`npm run check` 是当前唯一聚合 gate。测试/契约/迁移/基准脚本将随 Phase B+ 对应代码落地时引入（当前 Phase A 基线不含生产代码，测试脚本未声明以免指向不存在的文件）。详见 `AGENTS.md` 与 `docs/`。
