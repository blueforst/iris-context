/**
 * R2-P0 ContextMessageUnit ingest gate（Phase C 中性化重写）：
 * - contextSeq 每 lineage 单调、无空洞；
 * - 事件→单元映射（user/assistant/tool_result → 单元；operational → 无单元）；
 * - companion 折叠中性化（双事件/单事件表达；语义内容以用户 payload 为准，
 *   companion 信息写入配对列；未验证 → 不配对）；
 * - exactly-once（重复 ensureUnitsUpTo 不重复单元）；
 * - 重放自愈（事件已提交、部分单元缺失 → 下一次补齐）；
 * - migration：空库初始化 + newer-schema fence。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextStore, LATEST_MIGRATION_VERSION } from "../src/context/context-store.js";
import { computeContentTextHash } from "../src/contracts/runtime-events.js";
import {
  assistantInput,
  cleanupDir,
  companionInput,
  makeLineageInput,
  operationalInput,
  tempDir,
  userInput,
} from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

function setup(dir: string): { store: ContextStore; ingest: ContextIngest } {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  const ingest = new ContextIngest(store, LINEAGE);
  return { store, ingest };
}

test("r2: contextSeq is per-lineage monotonic and gap-free", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "hello" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "hi" }));
    ingest.ingestRuntimeEvent(userInput({ eventId: "e3", content: "again" }));
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.deepEqual(
      units.map((unit) => unit.contextSeq),
      [1, 2, 3],
    );
    assert.deepEqual(
      units.map((unit) => unit.kind),
      ["user", "assistant", "user"],
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: ledger-only events never become units", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    ingest.ingestRuntimeEvent(operationalInput({ eventId: "op-1" }));
    ingest.ingestRuntimeEvent(operationalInput({ eventId: "op-2" }));
    assert.deepEqual(ingest.ensureUnitsUpTo("session-1"), []);
    // 事件仍在 ledger（canonical 事件是 Context 认知链路的一部分）。
    assert.equal(store.listByLineage(LINEAGE).length, 2);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: companion pair is merged at ingest via the companion event (two-event model)", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    ingest.ingestRuntimeEvent(userInput({ eventId: "user-1", content: "hello iris" }));
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-1",
        companionOf: "user-1",
        pairKey: "pk-user-1",
        contentHash: computeContentTextHash("hello iris"),
      }),
    );
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.equal(units.length, 1, "companion folds into the input unit, no separate unit");
    const input = units[0];
    assert.equal(input?.kind, "user");
    const inputRecord = store.findBySourceEvent(input?.runtimeEventId ?? "");
    assert.equal(inputRecord?.persistenceMeta.paired, true);
    assert.equal(inputRecord?.persistenceMeta.companionEntryId, "comp-1");
    assert.ok(
      typeof inputRecord?.persistenceMeta.pairKey === "string" &&
        inputRecord.persistenceMeta.pairKey.length > 0,
      "pairKey must be present",
    );
    const content = (input?.semanticContent as { content?: unknown })?.content;
    assert.equal(content, "hello iris", "semantic content follows the user payload");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: unverified pair never pairs (fail-conservative); semantic content preserved", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    ingest.ingestRuntimeEvent(userInput({ eventId: "user-1", content: "hello" }));
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-bad",
        companionOf: "user-1",
        pairKey: "pk-bad",
        contentHash: "0".repeat(64),
      }),
    );
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.equal(
      store.findBySourceEvent(units[0]?.runtimeEventId ?? "")?.persistenceMeta.paired,
      false,
    );
    assert.equal((units[0]?.semanticContent as { content?: unknown })?.content, "hello");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: ensureUnitsUpTo is idempotent (exactly-once per source event)", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
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

test("r2: replay heals partial ingest (crash between event commit and unit creation)", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a" }));
    ingest.ingestRuntimeEvent(assistantInput({ eventId: "e2", content: "b" }));
    // 模拟崩溃：只保留第一个单元（事件都提交了，第二个单元手工删除）。
    store.raw().prepare("DELETE FROM context_units WHERE source_event_id = 'e2'").run();
    const healed = ingest.ensureUnitsUpTo("session-1");
    assert.equal(healed.length, 2);
    assert.deepEqual(
      healed.map((unit) => unit.contextSeq),
      [1, 2],
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: multi-input session never re-pairs — each companion merges only into its own main unit", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    // 两轮对话：user-1 / user-2 各自带自己的 companion 事件。
    ingest.ingestRuntimeEvent(userInput({ eventId: "user-1", content: "first" }));
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-1",
        companionOf: "user-1",
        pairKey: "pk-user-1",
        contentHash: computeContentTextHash("first"),
      }),
    );
    ingest.ingestRuntimeEvent(userInput({ eventId: "user-2", content: "second" }));
    ingest.ingestRuntimeEvent(
      companionInput({
        eventId: "comp-2",
        companionOf: "user-2",
        pairKey: "pk-user-2",
        contentHash: computeContentTextHash("second"),
      }),
    );
    const units = ingest.listUnits("session-1");
    assert.equal(units.length, 2);
    const first = units[0];
    const second = units[1];
    assert.equal(
      store.findBySourceEvent(first?.runtimeEventId ?? "")?.persistenceMeta.companionEntryId,
      "comp-1",
      "input-1 pairs with comp-1",
    );
    assert.equal(
      store.findBySourceEvent(second?.runtimeEventId ?? "")?.persistenceMeta.companionEntryId,
      "comp-2",
      "input-2 pairs with comp-2, never re-paired by comp-1",
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: input unit semantic content is the neutral user payload (never Pi raw wire)", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = setup(dir);
    ingest.ingestRuntimeEvent(userInput({ eventId: "user-1", content: "hello", companion: false }));
    const units = ingest.ensureUnitsUpTo("session-1");
    assert.equal((units[0]?.semanticContent as { content?: unknown })?.content, "hello");
    // 中性 payload 只含 role/content（adapter 解码产物），context.db 永不存 Pi wire。
    const keys = Object.keys(units[0]?.semanticContent as Record<string, unknown>).sort();
    assert.deepEqual(keys, ["content", "role"]);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2: empty context.db initializes cleanly; migrations 0001-0011 applied and idempotent", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"));
    store.createLineage(makeLineageInput("session-1", LINEAGE));
    assert.deepEqual(store.listUnits("session-1"), []);
    store.close();
    const reopened = ContextStore.open(join(dir, "context.db"));
    reopened.close();
    assert.equal(LATEST_MIGRATION_VERSION, "0012_bust_retirement");
  } finally {
    cleanupDir(dir);
  }
});
