/**
 * Phase C：中性 committed input port 测试。
 *
 * 证明 RuntimeEventInput（runtime-neutral，无 Pi 形状）→
 * CanonicalRuntimeEventV1 + ContextMessageUnitV1 的原子提交：
 *   1. RuntimeEvent 与 ContextMessageUnit 同一 SQLite 事务、同一 contextSeq
 *      原子提交（事件+单元要么都在、要么都不在）；
 *   2. contextSeq 按 lineage 全局单调、无空洞；
 *   3. exactly-once：同 idempotencyKey / eventId 重复 ingest 返回既有对，
 *      不产生重复 ledger 行 / 单元行；
 *   4. payload 语义校验 fail-closed（不符合语义 schema → 拒绝，不写入）；
 *   5. companion 折叠中性化（双事件模型 + 单事件标记）：语义内容以用户
 *      payload 为准，companion 信息写入配对列；contentHash 验证通过才配对，
 *      缺失/不匹配 → 不配对（fail-conservative）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextStore } from "../src/context/context-store.js";
import { computePayloadHash, computeContentTextHash } from "../src/contracts/runtime-events.js";
import { computeContextMessageUnitContentHashV1 } from "../src/contracts/context-v27.js";
import {
  assistantInput,
  cleanupDir,
  companionInput,
  makeLineageInput,
  operationalInput,
  tempDir,
  toolResultInput,
  userInput,
} from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

function openStore(dir: string): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

import { join } from "node:path";

test("neutral: RuntimeEvent + ContextMessageUnit commit atomically with the same contextSeq", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const result = ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello iris" }));
    assert.equal(result.event.schemaId, "iris.runtime_event.v1");
    assert.equal(result.event.contextLineageId, LINEAGE);
    assert.equal(result.event.contextSeq, 1);
    assert.equal(result.event.kind, "user");
    assert.equal(result.event.payloadHash, computePayloadHash(result.event.payload));
    assert.ok(result.unit !== null, "user event must produce a unit");
    assert.equal(result.unit.contextSeq, 1, "unit shares the event's contextSeq");
    assert.equal(result.unit.runtimeEventId, "e1");
    assert.equal(result.unit.kind, "user");
    assert.equal(result.unit.lifecycleState, "committed");
    // 原子：事件与单元都在。
    assert.equal(store.findRuntimeEventByEventId("e1")?.contextSeq, 1);
    assert.equal(store.findBySourceEvent("e1")?.unit.contextSeq, 1);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: contextSeq is lineage-global monotonic and gap-free across kinds", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "hi" }));
    ingest.ingestRuntimeEvent(toolResultInput({ eventId: "e3", text: "ok" }));
    ingest.ingestRuntimeEvent(userInput({ eventId: "e4", content: "again" }));
    const units = ingest.listUnits("session-1");
    assert.deepEqual(
      units.map((unit) => unit.contextSeq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      units.map((unit) => unit.kind),
      ["user", "assistant", "tool_result", "user"],
    );
    const events = store.listByLineage(LINEAGE);
    assert.deepEqual(
      events.map((event) => event.contextSeq),
      [1, 2, 3, 4],
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: exactly-once — duplicate eventId/idempotencyKey returns the existing pair", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const first = ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello" }));
    const second = ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello" }));
    assert.equal(second.event.runtimeEventId, first.event.runtimeEventId);
    assert.equal(second.event.contextSeq, first.event.contextSeq);
    assert.equal(second.unit?.contextUnitId, first.unit?.contextUnitId);
    const events = store.listByLineage(LINEAGE);
    assert.equal(events.length, 1, "no duplicate ledger row");
    assert.equal(store.listUnits("session-1").length, 1, "no duplicate unit");
    // 不同 idempotencyKey 但相同 payload 是新事件。
    const third = ingest.ingestRuntimeEvent(
      userInput({ eventId: "e2", content: "hello", sessionId: "session-1" }),
    );
    assert.equal(third.event.contextSeq, 2);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: payload failing the semantic schema is rejected (fail closed, nothing written)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const bad = userInput({ eventId: "bad", content: "x" });
    bad.payload = { role: "user", content: 42 }; // content 必须 string|array
    assert.throws(
      () => ingest.ingestRuntimeEvent(bad),
      /semantic content for kind user failed validation/,
    );
    // 事件与单元都不存在（原子失败，无半写入）。
    assert.equal(store.findRuntimeEventByEventId("bad"), undefined);
    assert.equal(store.findBySourceEvent("bad"), undefined);
    assert.equal(store.listByLineage(LINEAGE).length, 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: unknown kind is rejected (fail closed)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const input = userInput({ eventId: "x", content: "y" });
    (input as { kind: string }).kind = "mystery";
    assert.throws(() => ingest.ingestRuntimeEvent(input), /unknown RuntimeEventKind/);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: companion (two-event) — main user event + companionOf merges pairing into the main unit", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    // 双事件模型：主 user 事件（无标记）+ companion 事件（companionOf 指向主事件）。
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello iris" }));
    // 主事件先行：单元已建、未配对，语义内容以用户 payload 为准。
    const before = store.findBySourceEvent("e1");
    assert.ok(before !== undefined);
    assert.equal(before.persistenceMeta.paired, false);
    assert.equal((before.unit.semanticContent as { content?: unknown }).content, "hello iris");
    // companion 事件：contentHash 与主事件内容匹配 → 配对并入主单元。
    const comp = ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-1",
        companionOf: "e1",
        pairKey: "pk-e1",
        contentHash: computeContentTextHash("hello iris"),
      }),
    );
    assert.equal(comp.event.kind, "operational");
    assert.equal(comp.unit, null, "companion event produces no own unit");
    const record = store.findBySourceEvent("e1");
    assert.ok(record !== undefined);
    assert.equal(record.persistenceMeta.paired, true);
    assert.equal(record.persistenceMeta.companionEntryId, "comp-1");
    assert.equal(record.persistenceMeta.pairKey, "pk-e1");
    // 语义内容以用户 payload 为准（未被 companion 改写）。
    assert.equal((record.unit.semanticContent as { content?: unknown }).content, "hello iris");
    // contentHash 覆盖语义内容（版本化 basis）。
    const expectedHash = computeContextMessageUnitContentHashV1({
      semanticSchemaId: record.unit.semanticSchemaId,
      kind: record.unit.kind,
      historianDisposition: record.unit.historianDisposition,
      derivationRefs: record.unit.derivationRefs ?? {
        schemaId: "iris.semantic_derivation_refs.v1",
      },
      semanticContent: record.unit.semanticContent,
    });
    assert.equal(record.unit.contentHash, expectedHash);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: companion (single-event) — `companion` marker on the main event pairs at main ingest", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(
      userInput({
        eventId: "e1",
        content: "hello iris",
        companion: { pairKey: "pk-e1", contentHash: computeContentTextHash("hello iris") },
      }),
    );
    const record = store.findBySourceEvent("e1");
    assert.ok(record !== undefined);
    assert.equal(record.persistenceMeta.paired, true);
    assert.equal(record.persistenceMeta.pairKey, "pk-e1");
    assert.equal((record.unit.semanticContent as { content?: unknown }).content, "hello iris");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: companion with unverified/absent hash never pairs (fail-conservative, content preserved)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    // 无任何 companion：单元已建、未配对，语义内容 = 用户 payload。
    ingest.ingestRuntimeEvent(userInput({ eventId: "no-comp", content: "raw", companion: false }));
    assert.equal(
      (store.findBySourceEvent("no-comp")?.unit.semanticContent as { content?: unknown })?.content,
      "raw",
    );
    assert.equal(store.findBySourceEvent("no-comp")?.persistenceMeta.paired, false);
    // companion.contentHash 不匹配 → 不配对（但内容保留）。
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-bad",
        companionOf: "no-comp",
        pairKey: "pk-x",
        contentHash: "0".repeat(64),
      }),
    );
    const bad = store.findBySourceEvent("no-comp");
    assert.equal(bad?.persistenceMeta.paired, false);
    assert.equal((bad?.unit.semanticContent as { content?: unknown })?.content, "raw");
    // companion 缺 contentHash（不可验证）→ 不配对。
    ingest.ingestRuntimeEvent(
      companionInput({ eventId: "comp-no-hash", companionOf: "no-comp", pairKey: "pk-x" }),
    );
    assert.equal(store.findBySourceEvent("no-comp")?.persistenceMeta.paired, false);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: companion events never mis-pair — wrong companionOf, orphan, or already-paired are skipped", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "first" }));
    ingest.ingestRuntimeEvent(userInput({ eventId: "e2", content: "second" }));
    // e1 的 companion 错误指向不存在的 e9 → 不合并（无单元可配对）。
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-orphan",
        companionOf: "e9",
        pairKey: "pk-e9",
        contentHash: computeContentTextHash("first"),
      }),
    );
    // 孤立 companion（无 companionOf）→ 不合并（fail-conservative）。
    const orphan = {
      ...companionInput({ eventId: "comp-noref", companionOf: "e1", pairKey: "pk-e1" }),
    };
    delete (orphan as { companionOf?: string }).companionOf;
    orphan.idempotencyKey = "companion:comp-noref";
    ingest.ingestRuntimeEvent(orphan);
    assert.equal(store.findBySourceEvent("e1")?.persistenceMeta.paired, false);
    assert.equal(store.findBySourceEvent("e2")?.persistenceMeta.paired, false);
    // 正确配对 e1。
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-1",
        companionOf: "e1",
        pairKey: "pk-e1",
        contentHash: computeContentTextHash("first"),
      }),
    );
    assert.equal(store.findBySourceEvent("e1")?.persistenceMeta.paired, true);
    // 再发一个指向 e1 的 companion → 已配对 → 幂等跳过，不重配对（pairKey 保持）。
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-1b",
        companionOf: "e1",
        pairKey: "pk-other",
        contentHash: computeContentTextHash("first"),
      }),
    );
    assert.equal(store.findBySourceEvent("e1")?.persistenceMeta.pairKey, "pk-e1");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: ledger-only kinds (operational) commit the event but produce no unit", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const result = ingest.ingestRuntimeEvent(operationalInput({ eventId: "op-1" }));
    assert.equal(result.event.kind, "operational");
    assert.equal(
      result.unit,
      null,
      "operational event produces no ContextMessageUnit in this phase",
    );
    assert.equal(store.listByLineage(LINEAGE).length, 1);
    assert.equal(store.listUnits("session-1").length, 0);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: user unit stores only neutral canonical semantic content (never Pi raw wire)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "user-1", content: "hello", companion: false }));
    const content = (
      store.findBySourceEvent("user-1")?.unit.semanticContent as { content?: unknown }
    )?.content;
    // 中性 payload 已是 canonical 语义内容（adapter 解码产物），直接持久化；
    // context.db 永不存 Pi wire（payload 形状只含 role/content/timestamp）。
    assert.equal(content, "hello");
    const payload = store.findBySourceEvent("user-1")?.unit.semanticContent as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(payload).sort(), ["content", "role"]);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: ensureUnitsUpTo is idempotent replay (exactly-once per source event)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "b" }));
    const first = ingest.ensureUnitsUpTo("session-1");
    const second = ingest.ensureUnitsUpTo("session-1");
    assert.equal(second.length, first.length);
    assert.deepEqual(
      second.map((unit) => unit.contextSeq),
      [1, 2],
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: replay heals a missing unit (crash window recovery) with stable identity", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const first = ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "b" }));
    // 模拟事件已提交但单元缺失（手工删除单元行；事件行保留）。
    const db = store.raw();
    db.prepare("DELETE FROM context_units WHERE source_event_id = 'e2'").run();
    const healed = ingest.ensureUnitsUpTo("session-1");
    assert.equal(healed.length, 2);
    const healedUnit = store.findBySourceEvent("e2")?.unit;
    assert.ok(healedUnit !== undefined);
    assert.equal(healedUnit.contextSeq, 2);
    assert.equal(healedUnit.runtimeEventId, "e2");
    assert.equal(
      healedUnit.contentHash,
      computeContextMessageUnitContentHashV1({
        semanticSchemaId: healedUnit.semanticSchemaId,
        kind: healedUnit.kind,
        historianDisposition: healedUnit.historianDisposition,
        derivationRefs: healedUnit.derivationRefs ?? {
          schemaId: "iris.semantic_derivation_refs.v1",
        },
        semanticContent: healedUnit.semanticContent,
      }),
    );
    void first;
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: runtimeSessionId is attribution only — unknown session fails closed on ingest", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    const input = userInput({ eventId: "e1", content: "x", sessionId: "foreign-session" });
    assert.throws(() => ingest.ingestRuntimeEvent(input), /No durable context lineage is bound/);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("neutral: computeContentTextHash is the companion verification basis", () => {
  assert.equal(computeContentTextHash("hello"), computeContentTextHash("hello"));
  assert.notEqual(computeContentTextHash("hello"), computeContentTextHash("hellO"));
});
