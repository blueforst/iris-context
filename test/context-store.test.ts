/**
 * ContextStore 持久化层测试（Phase C 中性化重写）：
 * - createLineage / getLineage / getLineageByLineageId；
 * - insertUnit + rowToUnit 的 canonical hash 校验（tamper 检测 fail-closed）；
 * - lifecycle_state 持久化（committed → historian_eligible → ...）；
 * - pairing 元数据（insertUnit options.pairing → UnitStoreRecord）；
 * - newer-schema fence（未知迁移版本 → 拒绝打开）；
 * - 绑定 ledger（current/historical、checksum、reconciliation）。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  ContextLineageResolutionError,
  ContextStore,
  LATEST_MIGRATION_VERSION,
} from "../src/context/context-store.js";
import {
  SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  computeContextMessageUnitContentHashV1,
  type ContextMessageUnitV1,
} from "../src/contracts/context-v27.js";
import { cleanupDir, makeLineageInput, tempDir, userInput } from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

function unitFromInput(store: ContextStore, input: ReturnType<typeof userInput>): void {
  // 直接经 store 持久化一个单元（事件行也写入，保证 event/unit seq 共享空间一致）。
  store.beginAtomicIngest();
  try {
    const seq = store.nextContextSeqForLineage(LINEAGE);
    store.ingestRuntimeEvent(input, { contextLineageId: LINEAGE, contextSeq: seq });
    const payload = { role: "user", content: "[USER REQUEST | UNVERIFIED]" };
    const derivationRefs = { schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID };
    const unit: ContextMessageUnitV1 = {
      schemaId: "iris.context_message_unit.v1",
      contextUnitId: `input-${input.eventId}`,
      contextLineageId: LINEAGE,
      contextSeq: seq,
      runtimeEventId: input.eventId,
      kind: "user" as const,
      semanticSchemaId: "iris.semantic.context_message.user.v1",
      semanticContent: payload,
      historianDisposition: "include" as const,
      derivationRefs,
      contentHash: computeContextMessageUnitContentHashV1({
        semanticSchemaId: "iris.semantic.context_message.user.v1",
        kind: "user",
        historianDisposition: "include",
        derivationRefs,
        semanticContent: payload,
      }),
      lifecycleState: "committed" as const,
      createdAt: "2026-08-05T00:00:00.000Z",
    };
    store.insertUnit(unit, { runtimeSessionId: "session-1" });
    store.commitAtomicIngest();
  } catch (error) {
    store.rollbackAtomicIngest();
    throw error;
  }
}

function openStore(dir: string): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

test("store: createLineage + getLineage round-trips identity-level lineage", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const lineage = store.getLineage("session-1");
    assert.ok(lineage !== undefined);
    assert.equal(lineage.lineageId, LINEAGE);
    assert.equal(lineage.currentRuntimeSessionId, "session-1");
    assert.equal(lineage.representedThroughContextSeq, 0);
    assert.equal(lineage.emergencyState, "ok");
    assert.equal(store.getLineageByLineageId(LINEAGE)?.lineageId, LINEAGE);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: unit round-trips losslessly with canonical contentHash verification", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    unitFromInput(store, userInput({ eventId: "e1", content: "hello" }));
    const units = store.listUnits("session-1");
    assert.equal(units.length, 1);
    const unit = units[0];
    assert.equal(unit?.contextUnitId, "input-e1");
    assert.equal(unit?.contextSeq, 1);
    assert.equal(unit?.kind, "user");
    assert.equal(unit?.semanticSchemaId, "iris.semantic.context_message.user.v1");
    assert.equal(unit?.lifecycleState, "committed");
    assert.equal(unit?.historianDisposition, "include");
    store.close();
    // 重开：hash 校验通过（同一存储状态 → 同一 canonical hash）。
    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    assert.equal(reopened.listUnits("session-1").length, 1);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: lifecycle_state survives restart (lossless lifecycle persistence)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    unitFromInput(store, userInput({ eventId: "e1", content: "hello" }));
    // 推进 lifecycle：committed → historian_eligible（直接物理更新，模拟 Historian 路径）。
    store
      .raw()
      .prepare(
        "UPDATE context_units SET lifecycle_state = 'historian_eligible' WHERE source_event_id = 'e1'",
      )
      .run();
    store.close();
    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const unit = reopened.listUnits("session-1")[0];
    assert.equal(unit?.lifecycleState, "historian_eligible");
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: tampered semanticContent fails closed on read (content_hash mismatch)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    unitFromInput(store, userInput({ eventId: "e1", content: "hello" }));
    store
      .raw()
      .prepare("UPDATE context_units SET payload = ? WHERE source_event_id = 'e1'")
      .run(JSON.stringify({ role: "user", content: "TAMPERED" }));
    assert.throws(() => store.listUnits("session-1"), /content_hash mismatch/);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: pairing metadata via insertUnit options.pairing surfaces in UnitStoreRecord", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    store.beginAtomicIngest();
    try {
      const seq = store.nextContextSeqForLineage(LINEAGE);
      store.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello" }), {
        contextLineageId: LINEAGE,
        contextSeq: seq,
      });
      const payload = { role: "user", content: "[USER | cli | USER REQUEST | LIMITED]\nhello" };
      const derivationRefs = { schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID };
      const pairedUnit: ContextMessageUnitV1 = {
        schemaId: "iris.context_message_unit.v1",
        contextUnitId: "input-e1",
        contextLineageId: LINEAGE,
        contextSeq: seq,
        runtimeEventId: "e1",
        kind: "user",
        semanticSchemaId: "iris.semantic.context_message.user.v1",
        semanticContent: payload,
        historianDisposition: "include",
        derivationRefs,
        contentHash: computeContextMessageUnitContentHashV1({
          semanticSchemaId: "iris.semantic.context_message.user.v1",
          kind: "user",
          historianDisposition: "include",
          derivationRefs,
          semanticContent: payload,
        }),
        lifecycleState: "committed",
        createdAt: "2026-08-05T00:00:00.000Z",
      };
      store.insertUnit(pairedUnit, {
        runtimeSessionId: "session-1",
        pairing: { companionEntryId: "", pairKey: "pk-e1", paired: true },
      });
      store.commitAtomicIngest();
    } catch (error) {
      store.rollbackAtomicIngest();
      throw error;
    }
    const record = store.findBySourceEvent("e1");
    assert.ok(record !== undefined);
    assert.equal(record.persistenceMeta.pairKey, "pk-e1");
    assert.equal(record.persistenceMeta.paired, true);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: newer-schema fence — an applied version absent from the migration dir refuses open", async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "context.db");
    const store = ContextStore.open(dbPath, { lineageId: LINEAGE });
    store.close();
    // 模拟更新二进制：插入一个本目录不存在的迁移版本。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at, checksum) VALUES ('9999_future', ?, '')",
    ).run(new Date().toISOString());
    db.close();
    assert.throws(() => ContextStore.open(dbPath, { lineageId: LINEAGE }), /NEWER than this build/);
  } finally {
    cleanupDir(dir);
  }
});

test("store: LATEST_MIGRATION_VERSION is 0013_context_unit_v3", () => {
  assert.equal(LATEST_MIGRATION_VERSION, "0013_context_unit_v3");
});

test("store: unknown session fails closed (ContextLineageResolutionError), reconciliation API returns null", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    assert.throws(() => store.listUnits("unknown-session"), ContextLineageResolutionError);
    assert.equal(store.resolveLineageIdOrNull("unknown-session"), null);
    assert.equal(store.resolveLineageIdOrNull("session-1"), LINEAGE);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: bindCurrentSession marks the old binding historical and keeps resolution for recovery", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    store.bindCurrentSession(LINEAGE, "session-2");
    const lineage = store.getLineageByLineageId(LINEAGE);
    assert.equal(lineage?.currentRuntimeSessionId, "session-2");
    // 旧 session 在生产路径 fail-closed，但 recovery 仍可解析。
    assert.throws(() => store.listUnits("session-1"), ContextLineageResolutionError);
    const recovered = store.resolveLineageForRecovery("session-1", {
      sessionId: "session-1",
      entryId: "e1",
      contentHash: "a".repeat(64),
    });
    assert.equal(recovered, LINEAGE);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store: updateRepresentedThrough advances the contextSeq watermark", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    store.updateRepresentedThrough("session-1", 3);
    assert.equal(store.getLineage("session-1")?.representedThroughContextSeq, 3);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
