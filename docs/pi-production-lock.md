# Production Lock（v13 R0）

本仓库的 production lock 权威来源是 `src/contracts/pins/production-lock.json`，
由 `src/contracts/production-lock.ts` 类型化读取，
并由 `test/production-lock.test.ts` 作为 gate 验证（R0 Exit Gate：production lock 无 TBD）。

锁定的版本面（对应 Roadmap v13 R0 deliverables）：

| 面                        | 锁定值                                                                                                          | 状态                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Node                      | `>=22.19.0`（CI 精确 `22.19.0`），npm + package-lock.json                                                       | 已锁定                                                           |
| Pi packages（当前消费源） | `@earendil-works/pi-*@0.82.1`（npm registry release）                                                           | 已锁定                                                           |
| Pi 受控 fork              | `blueforst/pi` baseline `ab5f8d88…`；upstream base `e741cb05…`；audit baseline `b4f2936…/0.82.1`                | 已锁定（adoption 计划于 R1 seam 可用时切换）                     |
| Magic Context             | `cortexkit/magic-context` `v0.33.0` @ `48ab531d…`，authoritative path `packages/plugin/src/hooks/magic-context` | 已锁定                                                           |
| Memory contracts          | `iris-memory-contracts@0.1.1`，manifestSha256 `2cb22deb…`，owner `blueforst/iris_memory`                        | 已锁定（与 `src/contracts/pins/memory-contracts.json` 交叉一致） |
| Graphiti / Neo4j          | `graphiti-core@0.29.2`、neo4j driver min `5.26.0`（候选锁，owner `blueforst/iris_memory`；agent 无直接依赖）    | 候选锁定                                                         |

跨仓库一致性：Pi fork 的值与 `blueforst/pi` 的
`docs/iris-fork/production-lock.json` 对齐；memory contracts 的值与
`blueforst/iris_memory` 发布的契约 artifact `manifest.json` 对齐
（`test/memory-contract-gate.test.ts` 实际重算 SHA-256 验证）。

历史说明：旧 `candidate_selected_pending_contract_tests` 版本（earendil-works/pi
`b4f2936` / 0.82.1）已被 v13 fork 语义取代；该 commit 作为 upstream audit
baseline 保留在 lock 中，不再直接等同最终 production artifact。
