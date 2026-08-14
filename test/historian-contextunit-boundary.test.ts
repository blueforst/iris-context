/**
 * Feature 5（iris-context#2）：Historian 单一 ContextUnit 边界的回归保护测试。
 *
 * 对应 review finding 的三项敏感度门：
 *  1. freezeBatch/claimHistorianBatch 的 batch 成员必须与 context.db 持久化的
 *     同一个 ContextUnit 完全一致（unitId/contentHash/sourceRef —— 不得重新
 *     包装为第二 DTO、不得换身份/换 hash）；
 *  2. batch 路径不得由 legacy ContextMessageUnitV1 视图驱动：quarantined/legacy
 *     行绝不进入 batch；runtime-origin 成员 sourceRef 必须保持
 *     iris.dsh_message_ref.v1（不得退化为通用 sourceRef）；
 *  3. anti-echo 的 runtimeEventId 必须由 sourceRef 溯源
 *     （DshMessageRef → `dsh:<sessionId>:<messageId>`；通用 → sourceId）。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextAdmission } from "../src/context/context-admission.js";
import { ContextStore } from "../src/context/context-store.js";
import { createContextHistoryReadPort } from "../src/context/history-read-port.js";
import { DSH_MESSAGE_REF_V1_SCHEMA_ID, type DshMessageRef } from "../src/contracts/context-unit.js";
import { unitViewOf } from "../src/historian/anti-echo.js";
import type { HistorianBatchUnit } from "../src/contracts/historian.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";

const LINEAGE = "lineage-historian-boundary";

function setup(dir: string): { store: ContextStore; admission: ContextAdmission } {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return { store, admission: new ContextAdmission(store) };
}

test("F5: freezeBatch members are the SAME ContextUnit as persisted (identity/hash/sourceRef)", () => {
  const dir = tempDir();
  try {
    const { store, admission } = setup(dir);
    const u1 = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m1" },
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello" },
      runtimeSessionId: "session-1",
    });
    const u2 = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m2" },
      contentSchemaId: "iris.semantic.context_message.assistant.v1",
      content: { role: "assistant", content: "world", timestamp: 1 },
      runtimeSessionId: "session-1",
    });
    const port = createContextHistoryReadPort(store);
    const batch = port.freezeBatch({ afterContextSeqExclusive: 0, throughContextSeqInclusive: 2 });
    assert.equal(batch.schemaId, "iris.historian_batch.v2");
    assert.equal(batch.units.length, 2);
    const persisted = [u1, u2].map((u) => store.getContextUnitByUnitId(LINEAGE, u.unitId));
    for (let i = 0; i < batch.units.length; i += 1) {
      const member = batch.units[i];
      assert.ok(member !== undefined);
      const persistedUnit = persisted[i];
      assert.ok(persistedUnit !== undefined);
      // 同一个 ContextUnit：同一 identity/hash/content/sourceRef（不得重新包装）。
      assert.equal(member.unit.unitId, persistedUnit.unitId, "batch member keeps the same unitId");
      assert.equal(
        member.unit.contentHash,
        persistedUnit.contentHash,
        "batch member keeps the same contentHash",
      );
      assert.deepEqual(member.unit.content, persistedUnit.content);
      assert.deepEqual(member.unit.sourceRef, persistedUnit.sourceRef);
      // runtime-origin sourceRef 必须保持 DshMessageRef（不得退化为通用 sourceRef）。
      assert.equal(member.unit.sourceRef.schemaId, DSH_MESSAGE_REF_V1_SCHEMA_ID);
      const ref = member.unit.sourceRef as DshMessageRef;
      assert.equal(ref.sessionId, "s1");
      // sidecar 坐标：contextSeq 与持久化行一致。
      const row = store
        .raw()
        .prepare("SELECT context_seq FROM context_units WHERE unit_id = ?")
        .get(persistedUnit.unitId) as { context_seq: number };
      assert.equal(member.contextSeq, row.context_seq);
    }
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F5: legacy/quarantined rows never enter the batch; batch is v3-runtime driven", () => {
  const dir = tempDir();
  try {
    const { store, admission } = setup(dir);
    admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m1" },
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello" },
      runtimeSessionId: "session-1",
    });
    // 种子一个 quarantined legacy 行（v1 basis；物理隔离）。
    store
      .raw()
      .prepare(
        `INSERT INTO context_units (
           context_lineage_id, context_seq, unit_id, source_event_id, unit_type,
           disposition, content_hash, payload, schema_version, lifecycle_state,
           content_hash_basis, legacy_status, created_at, semantic_schema_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        LINEAGE,
        99,
        "legacy-q-1",
        "legacy-ev-99",
        "input",
        "include",
        "some-hash",
        JSON.stringify({ role: "user", content: "old" }),
        "context-unit-v1",
        "committed",
        "v1",
        "quarantined_legacy",
        "2026-08-01T00:00:00Z",
        "iris.semantic.context_message.user.v1",
      );
    const port = createContextHistoryReadPort(store);
    const batch = port.freezeBatch({
      afterContextSeqExclusive: 0,
      throughContextSeqInclusive: 1000,
    });
    // 只有 v3 runtime 单元进入 batch；quarantined legacy 行绝不进入。
    assert.equal(batch.units.length, 1);
    assert.equal(batch.units[0]?.unit.sourceRef.schemaId, DSH_MESSAGE_REF_V1_SCHEMA_ID);
    assert.notEqual(batch.units[0]?.unit.unitId, "legacy-q-1");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F5: anti-echo runtimeEventId derives from sourceRef (DshMessageRef / generic)", () => {
  // DshMessageRef 溯源。
  const dshMember: HistorianBatchUnit = {
    unit: {
      schemaId: "iris.context_unit.v3",
      unitId: "unit-1",
      contextId: LINEAGE,
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "x" },
      contentHash: "hash-1",
      sourceRef: {
        schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
        sessionId: "sess-9",
        messageId: "msg-9",
      },
    },
    contextSeq: 1,
    kind: "user",
    historianDisposition: "include",
    createdAt: "2026-08-01T00:00:00Z",
  };
  const view1 = unitViewOf(LINEAGE, dshMember);
  assert.equal(view1.runtimeEventId, "dsh:sess-9:msg-9", "DshMessageRef → dsh:session:message");
  assert.equal(view1.contextUnitId, "unit-1");
  assert.equal(view1.contentHash, "hash-1");

  // 通用 sourceRef 溯源。
  const genericMember: HistorianBatchUnit = {
    unit: {
      schemaId: "iris.context_unit.v3",
      unitId: "unit-2",
      contextId: LINEAGE,
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "y" },
      contentHash: "hash-2",
      sourceRef: {
        schemaId: "iris.context_unit_source_ref.v1",
        sourceSchemaId: "test.source.v1",
        sourceId: "src-2",
        sourceHash: "sh-2",
      },
    },
    contextSeq: 2,
    historianDisposition: "include",
    createdAt: "2026-08-01T00:00:00Z",
  };
  const view2 = unitViewOf(LINEAGE, genericMember);
  assert.equal(view2.runtimeEventId, "src-2", "generic sourceRef → sourceId");
});
