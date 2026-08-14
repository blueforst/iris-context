/**
 * F4 / R2 fail-closed 测试（Phase C 中性化重写）：
 * - 未知 session 写路径抛 ContextLineageResolutionError（无默认 lineage 回退）；
 * - rollover 后旧 session fail-closed；新 session 继续全局单调 contextSeq；
 * - 错误 data root（foreign session）绝不写入本 store 的 lineage；
 * - 重复 current binding 不可能（one lineage per session）；
 * - reconciliation API（resolveLineageIdOrNull）显式返回 null；
 * - 重启对账（replay ledger）exactly-once；
 * - 单元 lineageId 与 session 绑定不一致 → 拒绝。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextLineageResolutionError, ContextStore } from "../src/context/context-store.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import {
  assistantInput,
  cleanupDir,
  makeLineageInput,
  tempDir,
  userInput,
} from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

function openStore(dir: string): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

test("f4.1: unknown session on the write path throws ContextLineageResolutionError (no default fallback)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const input = userInput({ eventId: "e1", content: "x", sessionId: "ghost-session" });
    assert.throws(() => ingest.ingestRuntimeEvent(input), ContextLineageResolutionError);
    assert.equal(store.listByLineage(LINEAGE).length, 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.1: stale session after rollover fails closed (binding moved to new session)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "before" }));
    store.bindCurrentSession(LINEAGE, "session-2");
    // 旧 session 的生产写入 fail-closed。
    assert.throws(
      () =>
        ingest.ingestRuntimeEvent(
          userInput({ eventId: "e2", content: "stale", sessionId: "session-1" }),
        ),
      ContextLineageResolutionError,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.1: wrong data root (foreign session) never writes into this store's lineage", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    // foreign session 不在本 store 的 binding ledger（属于另一 data root）→
    // 生产写路径 fail-closed，绝不静默写入本 store 的默认 lineage。
    assert.throws(
      () =>
        ingest.ingestRuntimeEvent(
          userInput({ eventId: "e1", content: "x", sessionId: "foreign-session" }),
        ),
      ContextLineageResolutionError,
    );
    assert.equal(store.listUnitsByLineage(LINEAGE).length, 0);
    assert.equal(store.listByLineage(LINEAGE).length, 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.1: duplicate current binding is impossible (one lineage per session, one session per lineage)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    assert.throws(
      () => store.createLineage(makeLineageInput("session-1", "identity-other")),
      /already the current binding of lineage/,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.1: reconciliation API returns null for unknown sessions (explicit, never silent fallback)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    assert.equal(store.resolveLineageIdOrNull("unknown"), null);
    assert.equal(store.resolveLineageIdOrNull("session-1"), LINEAGE);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.1: restart reconciliation — replaying the ledger for a bound session is exactly-once", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    const store = ContextStore.open(dbPath, { lineageId: LINEAGE });
    store.createLineage(makeLineageInput("session-1", LINEAGE));
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "b" }));
    store.close();
    // 重启：重放 ledger 不产生重复单元。
    const reopened = ContextStore.open(dbPath, { lineageId: LINEAGE });
    const replay = new ContextIngest(reopened, LINEAGE);
    const units = replay.ensureUnitsUpTo("session-1");
    assert.deepEqual(
      units.map((unit) => unit.contextSeq),
      [1, 2],
    );
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.2: rollover — new session continues global monotonic contextSeq on the same lineage", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a" }));
    store.bindCurrentSession(LINEAGE, "session-2");
    const ingest2 = new ContextIngest(store, LINEAGE);
    ingest2.ingestRuntimeEvent(userInput({ eventId: "e2", content: "b", sessionId: "session-2" }));
    const units = store.listUnitsByLineage(LINEAGE);
    assert.deepEqual(
      units.map((unit) => unit.contextSeq),
      [1, 2],
    );
    assert.deepEqual(
      units.map((unit) => unit.runtimeEventId),
      ["e1", "e2"],
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("f4.3: a unit whose lineageId disagrees with its session binding is rejected", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a" }));
    // 手工把单元 lineage 改成另一个（模拟损坏/伪造）。
    store
      .raw()
      .prepare(
        "UPDATE context_units SET context_lineage_id = 'identity-other' WHERE source_event_id = 'e1'",
      )
      .run();
    // 按 session 读取时该单元不再可见（绑定指向本 lineage）。
    assert.equal(store.listUnits("session-1").length, 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
