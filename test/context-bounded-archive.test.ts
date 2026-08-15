/**
 * iris_agent#63/#74/#85：binding audit archive 与有界绑定 ledger（Phase C 中性化）。
 * - 已对账历史绑定回收 → audit 暂存 → 外部 archive 排干（crash-safe 三段协议）；
 * - 未对账/foreign 绑定永不回收，恢复仍可解析；
 * - audit 暂存 backlog 超硬上限 → typed fail-closed（ContextAuditBacklogExceededError）；
 * - 容量指标暴露 soft/hard 上限与 active DB/WAL 尺寸。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextAuditBacklogExceededError, ContextStore } from "../src/context/context-store.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

test("B74-AC: reclaimed bindings are staged then drained to the external archive (crash-safe)", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingRetainRecent: 1,
      archiveDbPath: join(dir, "context-archive.db"),
    });
    store.createLineage(makeLineageInput("s-a", LINEAGE));
    store.acknowledgeSessionReconciled("s-a");
    store.bindCurrentSession(LINEAGE, "s-b");
    store.acknowledgeSessionReconciled("s-b");
    store.bindCurrentSession(LINEAGE, "s-c");

    // 回收已对账历史绑定（保留最近 1 个）。
    const pruned = store.reclaimReconciledBindings({ retainRecent: 1 });
    assert.ok(pruned >= 1);
    // 排干到外部 archive。
    const drained = store.archiveBindingAudit({ batchLimit: 512 });
    assert.ok(drained.archived >= pruned, "audit rows drained to external archive");
    assert.equal(drained.stagedRemaining, 0, "active staging drained");
    const stats = store.bindingArchiveStats();
    assert.ok(stats.archiveRows >= pruned, "archive holds pruned rows");
    assert.ok(stats.activeDbBytes > 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("B74-AC: unreconciled sessions are never reclaimed; recovery stays resolvable", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingRetainRecent: 0,
    });
    store.createLineage(makeLineageInput("s-a", LINEAGE));
    store.bindCurrentSession(LINEAGE, "s-b"); // s-a 未对账
    const pruned = store.reclaimReconciledBindings({ retainRecent: 0 });
    assert.equal(pruned, 0, "unreconciled binding never pruned");
    assert.equal(
      store.resolveLineageForRecovery("s-a", {
        sessionId: "s-a",
        entryId: "e",
        contentHash: "a".repeat(64),
      }),
      LINEAGE,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("B74-AC: broken archive → staging backlog hits the HARD cap → typed fail-closed", () => {
  const dir = tempDir();
  try {
    // archive 路径指向一个文件（非目录）——每次排干失败，staging backlog 累积。
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingSoftLimit: 1,
      bindingHardLimit: 2,
      bindingRetainRecent: 0,
      archiveDbPath: join(blocker, "archive.db"),
      auditStagingSoftCap: 1,
      auditStagingHardCap: 2,
    });
    try {
      store.createLineage(makeLineageInput("s-1", LINEAGE));
      store.acknowledgeSessionReconciled("s-1");
      store.bindCurrentSession(LINEAGE, "s-2"); // 首次 rollover：无历史可回收，无排干。
      store.acknowledgeSessionReconciled("s-2");
      // 首次回收性 bind：排干失败（archive broken）——错误传播但 bind 已提交。
      assert.throws(() => {
        store.bindCurrentSession(LINEAGE, "s-3");
      });
      store.acknowledgeSessionReconciled("s-3");
      assert.throws(() => {
        store.bindCurrentSession(LINEAGE, "s-4");
      });
      store.acknowledgeSessionReconciled("s-4");
      // backlog 超硬上限（audit > 2）→ rollover gate fail-closed（提交前）。
      assert.throws(() => {
        store.bindCurrentSession(LINEAGE, "s-5");
      }, ContextAuditBacklogExceededError);
      const stats = store.bindingLedgerStats();
      assert.ok(stats.auditRows >= 2, "backlog visible in metrics");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("B74-AC: capacity metrics expose soft/hard limits and active DB/WAL sizes", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      bindingRetainRecent: 2,
    });
    const stats = store.bindingLedgerStats();
    assert.equal(stats.current, 0);
    store.createLineage(makeLineageInput("s-a", LINEAGE));
    const after = store.bindingLedgerStats();
    assert.equal(after.current, 1);
    assert.ok(after.total >= 1);
    assert.ok(after.reclaimable >= 0);
    const archive = store.bindingArchiveStats();
    assert.ok(archive.stagingSoftCap > 0);
    assert.ok(archive.stagingHardCap > 0);
    assert.ok(archive.activeDbBytes > 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("B85-AC: maintenance checkpoints WAL and reports active DB bytes", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput("s-a", LINEAGE));
    const result = store.maintenance();
    assert.ok(result.activeDbBytesAfter > 0);
    assert.ok(result.walBytesAfter >= 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
