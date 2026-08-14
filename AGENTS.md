# AGENTS.md

本文件是 `blueforst/iris-context` 仓库内所有开发 Agent 的工作契约。开始任务前必须先读取本文件，并在整个任务中遵守其中的权威来源、项目边界、验证和交付要求。

## 1. 权威来源

Iris 的 Notion 知识库是架构、规格和实现 Roadmap 的权威来源。本仓库的实现必须服从当前 Notion 规格正文（尤其 v27–v29 override），不得仅依据旧聊天摘要、缓存内容、历史设计演化页或 iris_agent 的旧代码推测规格。

开始实现前，必须读取与任务相关的当前规格正文：

- 设计根页：https://app.notion.com/p/3a4b98338da58121b863edb88e824edd
- 模块边界与状态所有权：https://app.notion.com/p/3a5b98338da581018d36c47276cb4358
- Canonical Schemas：https://app.notion.com/p/3b4b98338da581fa9563e34284331543
- Context Assembly：https://app.notion.com/p/3a4b98338da5813095a4f50fb6e15a26
- Historian：https://app.notion.com/p/3a4b98338da581d899aad7f9907af536
- Evidence & Semantic Memory：https://app.notion.com/p/3a4b98338da581589ba5ee8d23bd319b
- Long-Term Memory Service & Plugin Boundary：https://app.notion.com/p/3bcb98338da581ebbdead2b0cc188e25
- Composition & Plugin Model：https://app.notion.com/p/3bcb98338da58188aa6dd0cde6716e76
- Project Boundaries：https://app.notion.com/p/3aeb98338da581538acedc7ca9da57b9
- DSH Runtime Migration：https://app.notion.com/p/3bbb98338da5819ca950c242d20cff9e
- Roadmap：https://app.notion.com/p/3a9b98338da5819a8380f10dfb60932b
- Roadmap Detailed Specifications：https://app.notion.com/p/3b2b98338da581d0ac5cd0b997f38063

冲突优先级（由上级任务与 Issue #1 定义）：

```text
当前 Notion override
> Issue #1 中的 Owner 决策
> Issue #1 最新评论中的 Owner 补充
> 当前代码
> 历史测试
> 设计演化页
```

不得以旧代码或旧测试依赖某个行为为理由，继续实现已经被当前规格废止的架构。

## 2. 本仓库职责

本仓库（`blueforst/iris-context`）统一拥有 Context + Historian 领域：

- Context-facing canonical runtime-event normalization contract；
- `ContextMessageUnitV1` 语义 ledger、`contextLineageId/contextSeq`；
- `context.db`；
- Historian batch/claim/lease/receipt、processing profile；
- `historian.db`；
- P3 Compartment；
- provider-neutral Memory Observation/Publication authoring、outbox/archive；
- anti-echo、provenance、time、trust、attribution discipline；
- P0–P5 generation builder、validation、hashing；
- canonical BUST；
- P4 Recollection projector（仅 canonical BUST 更新）；
- P5 Live membership；
- representation/retirement/GC；
- Context/Historian migrations；
- Cordis services、source contribution seam、Historian semantic adapter seam；
- testkit、fixtures 与 benchmark。

本仓库不得：

- 依赖 Pi（`@earendil-works/pi-*`）的 Agent Loop、Pi Session repository、Pi `AgentMessage`/`CustomMessage` 作为公共契约；
- 依赖 Graphiti SDK、Neo4j 或 Graphiti-shaped DTO；
- 实现 provider-native renderer、Tool execution、Memory Service transport；
- 拥有 Host/CLI/Web、Persona/Work/Body 的权威 repository；
- 建立第二套 Plugin Manager、DI container、hook bus 或 lifecycle tree；
- 定义 m0/m1、LKG、SOFT/HARD、pass taxonomy、carrier、provider delta、invocation-local Context overlay、ContinuitySnapshot 等已废止概念。

## 3. 开始任务前

修改代码前依次完成：

1. 阅读本文件；
2. 重新读取 blueforst/iris-context#1 正文及全部评论（任务与审查问题的工作队列）；
3. 读取相关的当前 Notion 规格；
4. 检查仓库现状、已有实现和测试；
5. 确认没有未解决的 blocking finding（见 `unresolved-blocking-findings.md` 或 Issue #1）；
6. 在新增状态 owner、数据库、协议、后台 worker 或公开契约前，先识别是否与现有规格冲突。

## 4. 实现规则

- 每种持久状态只能有一个权威 owner；
- `ContextGenerationV2` 只有一个 materializer；P4 只有 canonical BUST 更新路径；
- Historian 属于 Context 模块；不创建 iris-historian 仓库；
- 跨模块和跨项目访问必须使用窄、版本化的契约；
- 不得直接访问其他模块的数据库、Repository、ORM entity 或具体 Adapter；
- 数据库结构变化必须提供向前 migration，并验证空数据库初始化与现有 data-root 兼容打开；
- 公开契约变化必须提供兼容性测试；
- Cordis reversible effects 不得删除 durable Context/Historian state；
- plugin unload 不删除 durable DB/Compartment/Publication/receipt/archive；
- 只有 mock 的行为必须明确标记为 mock；
- 未实际执行的测试或命令不得宣称已通过；
- 不得提交凭证、真实用户 Session 数据、模型载荷、私有日志或用户内容；
- 不得把空目录、占位接口或 smoke test 表述为对应能力已经完成。

## 5. 验证要求

提交或更新 PR 前，运行当前受影响区域已有的检查，至少包括：

- 格式、语法或 lint 检查；
- 类型化工具链的 typecheck；
- 相关单元测试；
- 相关契约测试；
- 修改持久化时运行 migration smoke test；
- `npm run check:codegen-freshness`（contract 生成物与 source 一致性）。

测试文件存在不等于测试已经通过。PR 中必须记录真实执行的命令和结果。

## 6. Git 与 Pull Request

每个边界清晰的工作项使用独立分支。达到可审查节点时，将工作推送到 GitHub 并创建或更新 PR。

PR 描述必须包含：

- 本仓库与 Issue #1 的关联；
- source repository 与 source SHA（历史提取来源）；
- 实现内容摘要与 Context/Historian ownership 说明；
- 持久状态、migration 或公开契约影响；
- 实际执行的命令和检查结果；
- 已知缺口、mock、失败项和未测试路径；
- Cordis service graph、Pi/Graphiti dependency fence 证明。

开发 Agent 可以在 PR 中声明完成情况，但不得自行提高 Notion Roadmap 的正式进度。

## 7. 暂停条件

仅暂停受影响的工作，适用情况包括：

- 必需的 Notion 内容无法访问；
- 必需的仓库、环境或凭证缺失；
- 将引入尚未解决的跨项目状态所有权冲突；
- 操作涉及破坏性、付费、外部发布或不可逆影响；
- 当前规格存在无法根据既定优先级规则裁决的根冲突。

存在不相关且不受阻的工作时，应继续推进，不要让单个阻塞停止整个任务。
