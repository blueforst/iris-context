# 历史提取说明（git-filter-repo）

本仓库的 Context + Historian 代码历史从 `blueforst/iris_agent` 经 `git-filter-repo` 提取并完整保留。

## 来源与基线

- source repository：`blueforst/iris_agent`
- source base SHA：`82c3f9bc47a8ecd6bc804c256d957397ca073573`（main，2026-08-14，PR #126 merge）
- source 总 commit 数：317
- 提取后 commit 数：277（仅保留与 Context/Historian/contracts 相关的路径及其历史）

> 修正记录（1）：初版提取误基于 fork 旧状态 `6702e61`（248 commits，PR #105，2026-08-11），遗漏了 round 6/7 的最新 Context 权威工作（durable ContextMessageUnitV1 统一、codegen/contract authority、P5 tamper detection 等）。经 Phase A 复审发现后，已从正确基线 `82c3f9bc` 重新提取并替换 merge 历史（本文件、source-inventory.md 与 Issue #1 评论均已同步更正）。
> 修正记录（2）：Phase B 调研发现初版路径清单遗漏根级 `contracts/`（单一机器权威 source `contracts/source/schemas.json` 与 `contracts/generated/`，含 A6 codegen 系统历史），已补入路径清单重新提取（276→277 commits，380→402 files）。

## 提取命令

在 iris_agent 的全新克隆上执行（`--force` 仅因本地克隆，非破坏性操作）：

```bash
git clone --no-local <iris_agent> /tmp/iris-context-history
cd /tmp/iris-context-history
git filter-repo --force \
  --path src/context \
  --path src/historian \
  --path src/contracts \
  --path contracts \
  --path src/db/migrations/context \
  --path src/db/migrations/historian \
  --path src/db/migrations/runtime-events \
  --path test \
  --path fixtures \
  --path docs \
  --path .github \
  --path scripts \
  --path package.json \
  --path package-lock.json \
  --path tsconfig.json \
  --path tsconfig.build.json \
  --path eslint.config.mjs \
  --path prettier.config.mjs \
  --path .prettierignore \
  --path .editorconfig \
  --path .gitignore \
  --path .nvmrc
```

产物：`/root/dsh-workspace/iris-context-history`（本地证据工件，277 commits / 402 files）。

## 历史接入方式

在 `extract-context-module` 分支上执行：

```bash
git remote add extracted <iris-context-history>
git fetch extracted
git merge --allow-unrelated-histories extracted/main \
  -m "chore(import): preserve extracted Context+Historian history from iris_agent via git-filter-repo"
```

该 merge commit（`<merge-sha>`）的祖先包含完整提取历史；后续各 Phase 从该历史恢复对应文件（`git checkout <extracted-tip> -- <path>`）并重构。因此本仓库对每个文件保留了其在 iris_agent 中的完整提交历史，不是无说明的快照复制。

## 说明

- 提取路径覆盖 Context/Historian 实现、相关 contracts、context/historian/runtime-events migrations、测试、fixtures、脚本与构建配置。
- 未提取（留 iris_agent）：`src/host/**`、`src/runtime/**`（Pi 运行时）、`src/config/**`、`src/db/migrations/{agent,ingress,runtime-epochs}`、agent-domain contracts（tool/origin/runtime/memory-pin/production-lock）等。
- `src/db/migrate.ts`（migration 基础设施）属 Context/Historian 公共设施，随 Phase C 从 iris_agent 恢复并纳入本仓库。
- 提取后各 Phase 会按当前 Notion 规格（v27–v29）删除被废止的实现（carrier/m0/m1/LKG/SOFT-HARD/ContinuitySnapshot 等）并重构剩余部分；删除均以 Issue #1 的 `unresolved-blocking-findings.md` 为依据记录。
