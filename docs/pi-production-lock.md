# Production Lock（v13 R0）

本仓库的 production lock 权威来源是 `src/contracts/pins/production-lock.json`，
由 `src/contracts/production-lock.ts` 类型化读取，
并由 `test/production-lock.test.ts` 作为 gate 验证（R0 Exit Gate：production lock 无 TBD）。

锁定的版本面（对应 Roadmap v13 R0 deliverables）：

| 面                        | 锁定值                                                                                                                                     | 状态                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Node                      | `>=22.19.0`（CI 精确 `22.19.0`），npm + package-lock.json                                                                                  | 已锁定                                                           |
| Pi packages（当前消费源） | `file:../pi/packages/{agent,ai,sqlite-node}`（相邻 blueforst/pi checkout，单机开发决策，未发布 npm）                                       | 已锁定                                                           |
| Pi 受控 fork              | `blueforst/pi` baseline `ab5f8d88…`；seam commit `3eac508b…`（tree `6059ca0b…`，issue iris_agent#41 修复链 HEAD）；acceptedRuntime `91bfa59a…`（tree `44d64fe…`，与 Pi 权威 lock 一致）；upstream base `e741cb05…`；audit baseline `b4f2936…/0.82.1` | 已锁定（file link 本地开发，未来多机部署切换 tarball/npm 发布）  |
| Magic Context             | `cortexkit/magic-context` `v0.33.0` @ `48ab531d…`，authoritative path `packages/plugin/src/hooks/magic-context`                            | 已锁定                                                           |
| Memory contracts          | `iris-memory-contracts@0.1.1`，manifestSha256 `2cb22deb…`，owner `blueforst/iris_memory`                                                   | 已锁定（与 `src/contracts/pins/memory-contracts.json` 交叉一致） |
| Graphiti / Neo4j          | `graphiti-core@0.29.2`、neo4j driver min `5.26.0`（候选锁，owner `blueforst/iris_memory`；agent 无直接依赖）                               | 候选锁定                                                         |

## 单一权威 Pi 身份（iris_agent#41）

Pi 的 accepted runtime 身份只有一个权威来源：`blueforst/pi` 的
`docs/iris-fork/production-lock.json` → `acceptedRuntime`（immutable commit + tree）。
本仓库的 pin 是**消费方视图**，必须与 Pi 权威 lock 交叉一致：

- `pi.fork.seamCommit` / `seamTree`：CI 与本地实际 checkout 的 Pi commit/tree
  （指向包含 iris_agent#41 修复链的 fork HEAD）；
- `pi.fork.acceptedRuntimeCommit` / `acceptedRuntimeTree`：Pi 权威 lock 声明的
  accepted runtime 身份，`test/production-lock.test.ts` 会读取相邻 `../pi` 的
  lock 并断言两者完全一致。

## 跨仓库 gate（fail-closed）

`test/production-lock.test.ts` 现在验证：

1. `../pi` 是真实 git 仓库（拒绝任意同名目录）；
2. `../pi` remote 属于 `blueforst/pi` / `ceyirelehe47/pi` fork 家族；
3. `../pi` HEAD 等于 `seamCommit` 且 HEAD tree 等于 `seamTree`；
4. `../pi/docs/iris-fork/production-lock.json` 的 `acceptedRuntime`
   与 pin 的 `acceptedRuntimeCommit/Tree` 一致，且该 commit 在 `../pi` 中存在、
   其 tree 与 Pi lock 记录一致；
5. `.github/workflows/ci.yml` 的 Pi checkout ref 由
   `scripts/read-pi-pin.mjs`（pin 派生）提供，不包含任何硬编码 Pi SHA；
6. 篡改 pin（stale/非法 SHA）时 pin reader fail-closed 退出非零。

## 本地 bootstrap（不触碰已有分支）

`node scripts/bootstrap-pi-checkout.mjs --check` 验证相邻 `../pi` 是否匹配 pin。

开发者在 Pi 上工作且不想移动自己的分支时，用独立 worktree：

```bash
node scripts/bootstrap-pi-checkout.mjs --worktree /path/to/pi-accepted \
  --fetch https://github.com/ceyirelehe47/pi.git
```

该命令创建 detached worktree 并精确 checkout 到 pin 的 seamCommit/tree，
绝不 reset 或移动任何已有分支；随后将 `package.json` 的 file: 依赖或开发
布局指向该 worktree（或把 `../pi` 链接到它）即可。

## 跨仓库一致性

- Pi fork 的值与 `blueforst/pi` 的 `docs/iris-fork/production-lock.json` 交叉验证
  （`test/production-lock.test.ts` 实际读取并断言）；
- memory contracts 的值与 `blueforst/iris_memory` 发布的契约 artifact
  `manifest.json` 对齐（`test/memory-contract-gate.test.ts` 实际重算 SHA-256 验证）；
- CI checkout ref 与 pin 派生一致（无第二份 SHA）。

历史说明：旧 `candidate_selected_pending_contract_tests` 版本（earendil-works/pi
`b4f2936` / 0.82.1）已被 v13 fork 语义取代；该 commit 作为 upstream audit
baseline 保留在 lock 中，不再直接等同最终 production artifact。
