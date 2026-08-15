/**
 * historical-lineage-recovery（Phase C 中性化重写）：
 * - crash → rollover → restart：历史 Session 经 resolveLineageForRecovery
 *   解析回同一 lineage，recovery-mode ContextIngest 按 lineage 直查重放，
 *   保持稳定 contextSeq（事件与单元原子提交后的 identity 不重分配）；
 * - rollover 后旧 session 的普通生产写入 fail-closed；
 * - binding ledger：append-only + checksum；foreign/fabricated/deleted/
 *   checksum-corrupt binding fail-closed；
 * - 已对账 binding 可回收（audit provenance）；未对账永不回收；
 * - binding ledger 硬上限 fail-closed。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextBindingLedgerExceededError, ContextStore } from "../src/context/context-store.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import { cleanupDir, makeLineageInput, tempDir, userInput } from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

function openStore(dir: string, options: Record<string, unknown> = {}): ContextStore {
  return ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE, ...options });
}

test("c1: crash -> rollover -> restart recovers Session A into the SAME lineage with stable identity, then B continues", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    const store = ContextStore.open(dbPath, { lineageId: LINEAGE });
    store.createLineage(makeLineageInput("session-a", LINEAGE));
    const ingestA = new ContextIngest(store, LINEAGE);
    ingestA.ingestRuntimeEvent(userInput({ eventId: "a1", content: "a1", sessionId: "session-a" }));
    ingestA.ingestRuntimeEvent(userInput({ eventId: "a2", content: "a2", sessionId: "session-a" }));
    // rollover：A → B。
    store.bindCurrentSession(LINEAGE, "session-b");
    const ingestB = new ContextIngest(store, LINEAGE);
    ingestB.ingestRuntimeEvent(userInput({ eventId: "b1", content: "b1", sessionId: "session-b" }));
    store.close();

    // 重启后模拟崩溃窗口：A 的第二个单元丢失（事件已提交）。
    const reopened = ContextStore.open(dbPath, { lineageId: LINEAGE });
    reopened.raw().prepare("DELETE FROM context_units WHERE source_event_id = 'a2'").run();
    // Recovery Reconciler：解析历史 Session A → 同一 lineage，recovery 模式重放。
    const recoveredLineage = reopened.resolveLineageForRecovery("session-a", {
      sessionId: "session-a",
      entryId: "a2",
      contentHash: "a".repeat(64),
    });
    assert.equal(recoveredLineage, LINEAGE);
    const reconciler = new ContextIngest(reopened, LINEAGE, true);
    reconciler.ensureUnitsUpTo("session-a");
    const units = reopened.listUnitsByLineage(LINEAGE);
    assert.deepEqual(
      units.map((unit) => unit.contextSeq),
      [1, 2, 3],
    );
    assert.deepEqual(
      units.map((unit) => unit.runtimeEventId),
      ["a1", "a2", "b1"],
    );
    // 重放不重复（exactly-once）。
    reconciler.ensureUnitsUpTo("session-a");
    assert.equal(reopened.listUnitsByLineage(LINEAGE).length, 3);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("c2: normal ingest from the old Session after rollover still fails closed; only the reconciler resolves it", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    store.createLineage(makeLineageInput("session-a", LINEAGE));
    store.bindCurrentSession(LINEAGE, "session-b");
    const ingest = new ContextIngest(store, LINEAGE);
    assert.throws(
      () =>
        ingest.ingestRuntimeEvent(
          userInput({ eventId: "x", content: "x", sessionId: "session-a" }),
        ),
      /No durable context lineage is bound/,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("c3: binding ledger keeps the full append-only history with integrity checksums", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    store.createLineage(makeLineageInput("session-a", LINEAGE));
    store.bindCurrentSession(LINEAGE, "session-b");
    store.bindCurrentSession(LINEAGE, "session-c");
    const stats = store.bindingLedgerStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.current, 1);
    assert.equal(stats.historical, 2);
    assert.equal(store.getLineage("session-c")?.currentRuntimeSessionId, "session-c");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("c4: foreign, fabricated, deleted and checksum-corrupt bindings fail closed", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    store.createLineage(makeLineageInput("session-a", LINEAGE));
    // foreign：本 data root 无绑定。
    assert.throws(
      () =>
        store.resolveLineageForRecovery("foreign", {
          sessionId: "foreign",
          entryId: "e",
          contentHash: "a".repeat(64),
        }),
      /no binding for runtime session foreign/,
    );
    // receipt 不属于该 session。
    assert.throws(
      () =>
        store.resolveLineageForRecovery("session-a", {
          sessionId: "other",
          entryId: "e",
          contentHash: "a".repeat(64),
        }),
      /belongs to session other/,
    );
    // malformed content hash。
    assert.throws(
      () =>
        store.resolveLineageForRecovery("session-a", {
          sessionId: "session-a",
          entryId: "e",
          contentHash: "not-a-hash",
        }),
      /malformed content hash/,
    );
    // checksum-corrupt binding。
    store
      .raw()
      .prepare(
        "UPDATE session_lineage_bindings SET binding_checksum = 'corrupt' WHERE runtime_session_id = 'session-a'",
      )
      .run();
    assert.throws(
      () =>
        store.resolveLineageForRecovery("session-a", {
          sessionId: "session-a",
          entryId: "e",
          contentHash: "a".repeat(64),
        }),
      /failed its checksum/,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("c5: reconciled historical bindings are reclaimed with audit provenance; unreconciled ones never pruned", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir, { bindingRetainRecent: 1 });
    store.createLineage(makeLineageInput("session-a", LINEAGE));
    store.acknowledgeSessionReconciled("session-a");
    store.bindCurrentSession(LINEAGE, "session-b");
    store.acknowledgeSessionReconciled("session-b");
    store.bindCurrentSession(LINEAGE, "session-c");
    // 未对账的 session-d 永不回收。
    store.bindCurrentSession(LINEAGE, "session-d");
    const pruned = store.reclaimReconciledBindings({ retainRecent: 1 });
    assert.ok(pruned >= 1, "reconciled historical bindings outside retain window pruned");
    // audit 表记录了 provenance（pruned rows copied before deletion）。
    const auditRows = (
      store.raw().prepare("SELECT COUNT(*) AS n FROM session_lineage_bindings_audit").get() as {
        n: number;
      }
    ).n;
    assert.ok(auditRows >= pruned);
    // session-d（未对账）仍可解析。
    const recovered = store.resolveLineageForRecovery("session-d", {
      sessionId: "session-d",
      entryId: "e",
      contentHash: "a".repeat(64),
    });
    assert.equal(recovered, LINEAGE);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("c6: binding ledger hard limit fails closed even with unprunable rows (bounded growth)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir, {
      bindingSoftLimit: 2,
      bindingHardLimit: 4,
      bindingRetainRecent: 0,
    });
    store.createLineage(makeLineageInput("s0", LINEAGE));
    // 不 acknowledge：历史绑定全部未对账 → 永不可回收（reclaim 无效果），
    // 硬上限必然触发 fail-closed。
    for (let i = 1; i <= 4; i += 1) {
      store.bindCurrentSession(LINEAGE, `s${i}`);
    }
    assert.throws(() => {
      store.bindCurrentSession(LINEAGE, "s5");
    }, ContextBindingLedgerExceededError);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
