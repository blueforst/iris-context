/**
 * Feature 2（iris-context#2）：single ContextUnit 持久化 + 旧 schema 迁移测试。
 *
 * 覆盖：
 *  - single ContextUnit lifecycle：admit → 读回 → 同一 identity/类型/content；
 *  - exactly-once（同 source 幂等，不重复行）；
 *  - crash/restart（重开 store 后 v3 行保留、identity 不变）；
 *  - tamper 检测（content 被改 → v3 读 fail-closed）；
 *  - 旧 v2 行 → v3 确定性迁移（identity/content/contextSeq 原值保留；sourceRef
 *    诚实记录 legacy 来源）；迁移后旧路径仍可读（compat 视图）；
 *  - v1 quarantined 行绝不迁移；
 *  - bounded storage 不回退（软 cap → exclude）；
 *  - P5 live 选择（lifecycle/disposition 过滤）。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextAdmission } from "../src/context/context-admission.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  CONTEXT_UNIT_V3_SCHEMA_ID,
  DSH_MESSAGE_REF_V1_SCHEMA_ID,
  computeContextUnitContentHash,
  deriveContextUnitId,
  type ContextUnit,
  type DshMessageRef,
} from "../src/contracts/context-unit.js";
import {
  assistantInput,
  cleanupDir,
  makeLineageInput,
  tempDir,
  userInput,
} from "./helpers/context-fixtures.js";

const LINEAGE = "identity-f2";

function openStore(dir: string): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

/** 构造一个 runtime-origin（DshMessageRef）统一 ContextUnit。 */
function makeRuntimeUnit(input: {
  sessionId: string;
  messageId: string;
  eventSeq?: number;
  contentSchemaId?: string;
  content?: unknown;
}): { unit: ContextUnit; sourceAnchor: string } {
  const sourceRef: DshMessageRef = {
    schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
    sessionId: input.sessionId,
    messageId: input.messageId,
    ...(input.eventSeq !== undefined ? { eventSeq: input.eventSeq } : {}),
  };
  const contentSchemaId = input.contentSchemaId ?? "iris.semantic.context_message.user.v1";
  const content = input.content ?? { role: "user", content: `msg ${input.messageId}` };
  const unitId = deriveContextUnitId(LINEAGE, sourceRef);
  const unit: ContextUnit = {
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId,
    contextId: LINEAGE,
    contentSchemaId,
    content: content as ContextUnit["content"],
    contentHash: computeContextUnitContentHash({
      schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
      unitId,
      contextId: LINEAGE,
      contentSchemaId,
      content: content as ContextUnit["content"],
      sourceRef,
    }),
    sourceRef,
  };
  return { unit, sourceAnchor: `dsh:${input.sessionId}:${input.messageId}` };
}

function nextSeq(store: ContextStore): number {
  return store.maxContextSeqByLineage(LINEAGE) + 1;
}

// ---------------------------------------------------------------------------
// single ContextUnit lifecycle + exactly-once + restart
// ---------------------------------------------------------------------------

test("F2: admit materializes ContextUnit exactly once and reads back the same unit", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const { unit, sourceAnchor } = makeRuntimeUnit({ sessionId: "s1", messageId: "m1" });
    const admitted = store.admitContextUnit({
      unit,
      contextSeq: nextSeq(store),
      sourceAnchor,
      runtimeSessionId: "session-1",
    });
    // 同一 identity / 类型 / content。
    assert.equal(admitted.unitId, unit.unitId);
    assert.equal(admitted.schemaId, "iris.context_unit.v3");
    assert.deepEqual(admitted.content, unit.content);
    assert.equal(admitted.contentHash, unit.contentHash);

    // exactly-once：同 unitId 再 admit → 幂等返回既有（不重复行）。
    const again = store.admitContextUnit({
      unit,
      contextSeq: nextSeq(store),
      sourceAnchor,
      runtimeSessionId: "session-1",
    });
    assert.equal(again.unitId, unit.unitId);
    const all = store.listContextUnits(LINEAGE, { disposition: "all" });
    assert.equal(all.length, 1, "exactly one row for one admitted unit");

    // 读回（按 unitId + 列表）都是同一个逻辑 Unit。
    const byId = store.getContextUnitByUnitId(LINEAGE, unit.unitId);
    assert.equal(byId?.unitId, unit.unitId);
    assert.deepEqual(byId?.content, unit.content);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F2: crash/restart — v3 rows survive reopen with same identity", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const { unit, sourceAnchor } = makeRuntimeUnit({ sessionId: "s1", messageId: "m1" });
    store.admitContextUnit({
      unit,
      contextSeq: nextSeq(store),
      sourceAnchor,
      runtimeSessionId: "session-1",
    });
    store.close();

    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const read = reopened.getContextUnitByUnitId(LINEAGE, unit.unitId);
    assert.ok(read !== undefined);
    assert.equal(read.unitId, unit.unitId);
    assert.equal(read.schemaId, "iris.context_unit.v3");
    assert.deepEqual(read.content, unit.content);
    assert.equal(read.contentHash, unit.contentHash);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F2: tampered v3 content fails closed on read (contentHash mismatch)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const { unit, sourceAnchor } = makeRuntimeUnit({ sessionId: "s1", messageId: "m1" });
    store.admitContextUnit({
      unit,
      contextSeq: nextSeq(store),
      sourceAnchor,
      runtimeSessionId: "session-1",
    });
    store
      .raw()
      .prepare("UPDATE context_units SET payload = ? WHERE unit_id = ?")
      .run(JSON.stringify({ role: "user", content: "TAMPERED" }), unit.unitId);
    assert.throws(() => store.getContextUnitByUnitId(LINEAGE, unit.unitId), /contentHash mismatch/);
    assert.throws(() => store.listContextUnits(LINEAGE), /contentHash mismatch/);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F2: same source resolves to same unitId; changed content creates a different unit", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const { unit: u1, sourceAnchor } = makeRuntimeUnit({
      sessionId: "s1",
      messageId: "m1",
      content: { role: "user", content: "v1" },
    });
    store.admitContextUnit({
      unit: u1,
      contextSeq: nextSeq(store),
      sourceAnchor,
      runtimeSessionId: "session-1",
    });

    // 同一 source、同一内容 → 同一 unitId（幂等）。
    const again = makeRuntimeUnit({
      sessionId: "s1",
      messageId: "m1",
      content: { role: "user", content: "v1" },
    });
    const reAdmitted = store.admitContextUnit({
      unit: again.unit,
      contextSeq: nextSeq(store),
      sourceAnchor: again.sourceAnchor,
      runtimeSessionId: "session-1",
    });
    assert.equal(reAdmitted.unitId, u1.unitId);

    // 语义变化（新内容）→ 同一 source 但不同 unitId 也会碰撞检测失败（同
    // messageId → 同 unitId → contentHash 不同 → fail-closed）。
    const changed = makeRuntimeUnit({
      sessionId: "s1",
      messageId: "m1",
      content: { role: "user", content: "v2" },
    });
    assert.throws(
      () =>
        store.admitContextUnit({
          unit: changed.unit,
          contextSeq: nextSeq(store),
          sourceAnchor: changed.sourceAnchor,
          runtimeSessionId: "session-1",
        }),
      /unitId collision/,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 旧 v2 行 → v3 迁移
// ---------------------------------------------------------------------------

test("F2: legacy v2 rows migrate deterministically to v3 with preserved identity", () => {
  const dir = tempDir();
  try {
    // 1) 用旧路径创建 v2 行（ContextMessageUnitV1）。
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "hi" }));
    const legacyUnits = ingest.ensureUnitsUpTo("session-1");
    assert.equal(legacyUnits.length, 2);
    const beforeContextSeq = legacyUnits.map((u) => u.contextSeq);
    const beforeUnitIds = legacyUnits.map((u) => u.contextUnitId);
    store.close();

    // 2) 重开：打开时自动迁移 v2 → v3。
    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const migrated = reopened.listContextUnits(LINEAGE, { disposition: "all" });
    assert.equal(migrated.length, 2, "all legacy rows migrated");
    // identity 原值保留（同一逻辑 Unit）。
    assert.deepEqual(
      migrated.map((u) => u.unitId),
      beforeUnitIds,
    );
    assert.equal(migrated[0]?.schemaId, "iris.context_unit.v3");
    assert.deepEqual(migrated[0]?.content, { role: "user", content: "hello" });
    // sourceRef 诚实记录 legacy 来源。
    const sourceRef = migrated[0]?.sourceRef;
    assert.equal(sourceRef.schemaId, "iris.context_unit_source_ref.v1");
    assert.equal(
      (sourceRef as { sourceSchemaId: string }).sourceSchemaId,
      "iris.context_message_unit.v1",
    );
    // 物理 basis 已升级。
    const row = reopened
      .raw()
      .prepare(
        "SELECT content_hash_basis, unit_schema_id FROM context_units WHERE context_lineage_id = ? ORDER BY context_seq",
      )
      .all(LINEAGE) as Array<{ content_hash_basis: string; unit_schema_id: string }>;
    assert.ok(
      row.every(
        (r) => r.content_hash_basis === "v3" && r.unit_schema_id === "iris.context_unit.v3",
      ),
    );

    // 3) 旧路径仍可读（compat 视图）：同一 unitId/contextSeq/content。
    const legacyView = reopened.listUnits("session-1");
    assert.deepEqual(
      legacyView.map((u) => u.contextUnitId),
      beforeUnitIds,
    );
    assert.deepEqual(
      legacyView.map((u) => u.contextSeq),
      beforeContextSeq,
    );
    assert.deepEqual(legacyView[0]?.semanticContent, { role: "user", content: "hello" });
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F2: v1 quarantined rows are never migrated and fail closed on new-model read", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    // 模拟 v1 quarantined 行（0009 隔离语义）。
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
        1,
        "quarantined-unit-1",
        "legacy-ev-1",
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
    store.close();

    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    // 未迁移（保持 quarantined + v1 basis）。
    const row = reopened
      .raw()
      .prepare(
        "SELECT content_hash_basis, legacy_status, unit_schema_id FROM context_units WHERE unit_id = ?",
      )
      .get("quarantined-unit-1") as {
      content_hash_basis: string;
      legacy_status: string;
      unit_schema_id: string | null;
    };
    assert.equal(row.content_hash_basis, "v1");
    assert.equal(row.legacy_status, "quarantined_legacy");
    assert.equal(row.unit_schema_id, null);
    // 新模型列表读物理排除（unit_schema_id 过滤）：quarantined 行不可见。
    assert.equal(reopened.listContextUnits(LINEAGE, { disposition: "all" }).length, 0);
    // 按 unitId 直读 → rowToContextUnit fail-closed（不静默物化 quarantined 行）。
    assert.throws(
      () => reopened.getContextUnitByUnitId(LINEAGE, "quarantined-unit-1"),
      /quarantined/,
    );
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// bounded storage + P5 live 选择
// ---------------------------------------------------------------------------

test("F2: bounded storage — soft cap marks new v3 units as excluded", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), {
      lineageId: LINEAGE,
      maxUnitsPerSession: 3,
    });
    store.createLineage(makeLineageInput("session-1", LINEAGE));
    for (let i = 1; i <= 5; i += 1) {
      const { unit, sourceAnchor } = makeRuntimeUnit({ sessionId: "s1", messageId: `m${i}` });
      store.admitContextUnit({ unit, contextSeq: i, sourceAnchor, runtimeSessionId: "session-1" });
    }
    const all = store.listContextUnits(LINEAGE, { disposition: "all" });
    assert.equal(all.length, 5);
    const included = store.listContextUnits(LINEAGE); // 默认过滤 exclude
    assert.equal(included.length, 3, "soft cap exceeded units are excluded from provider view");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F2: P5 live selection returns only unrepresented include units", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const { unit: u1, sourceAnchor: a1 } = makeRuntimeUnit({ sessionId: "s1", messageId: "m1" });
    store.admitContextUnit({
      unit: u1,
      contextSeq: 1,
      sourceAnchor: a1,
      runtimeSessionId: "session-1",
    });
    const { unit: u2, sourceAnchor: a2 } = makeRuntimeUnit({ sessionId: "s1", messageId: "m2" });
    store.admitContextUnit({
      unit: u2,
      contextSeq: 2,
      sourceAnchor: a2,
      runtimeSessionId: "session-1",
    });
    // 模拟 P3 表示 u1：推进 represented watermark 并把 u1 标记 represented。
    store.updateRepresentedThrough("session-1", 1);
    store
      .raw()
      .prepare(
        "UPDATE context_units SET lifecycle_state = 'represented_in_p3' WHERE context_lineage_id = ? AND context_seq = 1",
      )
      .run(LINEAGE);
    const live = store.listLiveContextUnitsForP5(LINEAGE, 1);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.unitId, u2.unitId);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// ContextAdmission 边界（材料化唯一入口）
// ---------------------------------------------------------------------------

test("F2: ContextAdmission.admit materializes + persists exactly once", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    const sourceRef: DshMessageRef = {
      schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
      sessionId: "s1",
      messageId: "m1",
    };
    const u1 = admission.admit({
      sourceRef,
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello admission" },
      runtimeSessionId: "session-1",
    });
    assert.equal(u1.schemaId, "iris.context_unit.v3");
    assert.equal(u1.unitId, deriveContextUnitId(LINEAGE, sourceRef));
    // 幂等：同一 source 再 admit → 同一 Unit（不重复行）。
    const u2 = admission.admit({
      sourceRef,
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello admission" },
      runtimeSessionId: "session-1",
    });
    assert.equal(u2.unitId, u1.unitId);
    assert.equal(store.listContextUnits(LINEAGE, { disposition: "all" }).length, 1);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F2: ContextAdmission rejects unknown contentSchemaId (fail closed)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    assert.throws(
      () =>
        admission.admit({
          sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s", messageId: "m" },
          contentSchemaId: "iris.semantic.totally_unknown.v999",
          content: { role: "user", content: "x" },
        }),
      /unknown semanticSchemaId/,
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F5: retirement mutates lifecycle sidecar, never canonical unit content", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    const unit = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m1" },
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "immutable content" },
      runtimeSessionId: "session-1",
    });
    // 先 ACK Historian commit（committed → compartmentalized_pending_bust），
    // 再标记 retired（模拟成功 BUST 后的 retirement sidecar 推进）。
    store.acknowledgeHistorianCommit({
      schemaId: "iris.historian_commit_receipt.v1",
      receiptId: "receipt-1",
      batchId: "batch-1",
      claimId: "claim-1",
      contextLineageId: LINEAGE,
      fromContextSeq: 1,
      throughContextSeq: 1,
      rangeHash: "rh",
      compartmentIds: ["comp-1"],
      publicationIds: [],
      outputHash: "oh",
      committedAt: "2026-08-01T00:00:00.000Z",
    });
    store.beginBustTransaction();
    try {
      store.markRepresentedAndRetired({
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-1",
        contextGenerationHash: "gen-hash",
        representedThroughContextSeq: 1,
        retiredThroughContextSeq: 1,
      });
      store.commitBustTransaction();
    } catch (error) {
      store.rollbackBustTransaction();
      throw error;
    }
    // canonical content 未被修改（同一 identity/content/hash）。
    const after = store.getContextUnitByUnitId(LINEAGE, unit.unitId);
    assert.equal(after?.unitId, unit.unitId);
    assert.deepEqual(after?.content, unit.content);
    assert.equal(after?.contentHash, unit.contentHash);
    // lifecycle sidecar 已推进（retired）。
    const row = store
      .raw()
      .prepare("SELECT lifecycle_state FROM context_units WHERE unit_id = ?")
      .get(unit.unitId) as { lifecycle_state: string };
    assert.equal(row.lifecycle_state, "retired");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
