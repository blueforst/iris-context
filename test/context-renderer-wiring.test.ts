/**
 * R3-P1：ContextRenderer.onMaterialized freeze-trigger 接线测试。
 *
 * 覆盖：
 *  - HARD persistRender 提交后调用 onMaterialized，携带本次 fold watermark
 *    对应的 entrySeq（store 聚合，与 ContextHistoryReadPort 同源）；
 *  - SOFT / SOFT+ persistRender 不调用 onMaterialized（m0 未推进）；
 *  - 无 render 记录 → no-op，不调用；
 *  - onMaterialized 传入的 entrySeq 与 ContextHistoryReadPort 读取的
 *    representedThroughEntrySeq 一致（同源交叉验证）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { ContextIngest } from "../src/context/context-ingest.js";
import { ContextRenderer } from "../src/context/context-renderer.js";
import { ContextStore } from "../src/context/context-store.js";
import { createContextHistoryReadPort } from "../src/context/history-read-port.js";
import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";
import type { PiSeamEvent } from "../src/contracts/runtime-events.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";

const SESSION = "iris-runtime-2026-08-01-1";
const NOW_MS = 1_785_000_000_000;

const HARD_SIGNALS = {
  modelKey: "mock-iris:mock-deepseek-v4-flash",
  systemHash: "sys-hash-1",
  providerProfileId: "mock",
};

function makeLineageInput(): Parameters<ContextStore["createLineage"]>[0] {
  return {
    runtimeSessionId: SESSION,
    contextSourceSnapshotId: "src-1",
    epochId: SESSION,
    personaSnapshotId: "persona-default-v1",
    declarationVersion: "decl-v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "IRIS SYSTEM PROMPT V1",
    systemProjectionHash: "sys-hash-1",
    preparedAt: "2026-08-01T00:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-units-v1",
    carrierSchemaVersion: "1",
  };
}

interface Fixture {
  dir: string;
  store: ContextStore;
  ledger: RuntimeEventLedger;
  ingest: ContextIngest;
  renderer: ContextRenderer;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "iris-renderer-wiring-"));
  const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
  const store = ContextStore.open(join(dir, "context.db"));
  store.createLineage(makeLineageInput());
  const ingest = new ContextIngest(ledger, store, store.lineageId);
  const renderer = new ContextRenderer(store);
  return { dir, store, ledger, ingest, renderer };
}

function closeFixture(fixture: Fixture): void {
  fixture.store.close();
  fixture.ledger.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

let eventOrdinal = 0;

/** 带 entrySeq 的 message_finalized 事件（receipt 收据语义：可选 entrySeq）。 */
function sampleEvent(overrides: Partial<PiSeamEvent>): PiSeamEvent {
  eventOrdinal += 1;
  return {
    type: "message_finalized",
    runtimeSessionId: SESSION,
    piSessionId: SESSION,
    entryId: `entry-${overrides.role ?? "x"}-${eventOrdinal}`,
    role: "user",
    contentHash: "a".repeat(64),
    occurredAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function userMessageWire(): string {
  return JSON.stringify({ role: "user", content: "hello iris", timestamp: 1_700_000_000_000 });
}

function companionWire(): string {
  return JSON.stringify({
    role: "custom",
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: IRIS_INPUT_META_CONTENT,
    display: false,
  });
}

function assistantWire(text: string): string {
  return JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "opencode",
    provider: "opencode",
    model: "deepseek-v4-flash",
    timestamp: 1_700_000_000_001,
  });
}

/** 灌入一次完整 turn（user + companion + assistant），user/assistant 携带 entrySeq。 */
function ingestTurn(fixture: Fixture, turn: number): void {
  fixture.ledger.ingest(
    sampleEvent({
      role: "user",
      entryId: `user-${turn}`,
      entrySeq: (turn - 1) * 3 + 1,
      payload: userMessageWire(),
    }),
  );
  fixture.ledger.ingest(
    sampleEvent({ role: "custom", entryId: `comp-${turn}`, payload: companionWire() }),
  );
  fixture.ledger.ingest(
    sampleEvent({
      role: "assistant",
      entryId: `assistant-${turn}`,
      entrySeq: (turn - 1) * 3 + 3,
      payload: assistantWire(`the answer is ${turn}`),
    }),
  );
}

test("R3-P1 renderer: HARD persistRender invokes onMaterialized with the fold watermark's entrySeq", () => {
  const fixture = makeFixture();
  try {
    ingestTurn(fixture, 1);
    const calls: Array<{ runtimeSessionId: string; entrySeq: number | null }> = [];
    fixture.renderer.onMaterialized = (runtimeSessionId, representedThroughEntrySeq) => {
      calls.push({ runtimeSessionId, entrySeq: representedThroughEntrySeq });
    };
    const units = fixture.ingest.ensureUnitsUpTo(SESSION);
    // turn1：user(1) + companion 折叠 + assistant(3) → contextSeq 1/2，HARD first_render。
    assert.equal(units.length, 2);
    const { record } = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units,
      liveDelta: [],
      hardSignals: HARD_SIGNALS,
    });
    assert.equal(record.classification, "HARD");
    fixture.renderer.persistRender(NOW_MS);
    assert.equal(calls.length, 1, "HARD persist triggers onMaterialized exactly once");
    const call = calls[0];
    assert.ok(call, "callback received a call");
    assert.equal(call.runtimeSessionId, SESSION);
    // watermark = maxContextSeq = 2 → MAX(entry_seq over context_seq <= 2) = 3。
    assert.equal(call.entrySeq, 3);
  } finally {
    closeFixture(fixture);
  }
});

test("R3-P1 renderer: onMaterialized entrySeq agrees with the ContextHistoryReadPort boundary", () => {
  const fixture = makeFixture();
  try {
    ingestTurn(fixture, 1);
    let reported: number | null | undefined;
    fixture.renderer.onMaterialized = (_runtimeSessionId, representedThroughEntrySeq) => {
      reported = representedThroughEntrySeq;
    };
    const units = fixture.ingest.ensureUnitsUpTo(SESSION);
    fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units,
      liveDelta: [],
      hardSignals: HARD_SIGNALS,
    });
    fixture.renderer.persistRender(NOW_MS);
    assert.ok(reported !== undefined, "onMaterialized was invoked");
    const boundary = createContextHistoryReadPort(fixture.store).getMaterializedBoundary(SESSION);
    assert.equal(reported, boundary.representedThroughEntrySeq, "同源：renderer 聚合 == port 聚合");
    assert.equal(boundary.representedThroughContextSeq, 2);
    assert.equal(boundary.lineageStatus, "ok");
  } finally {
    closeFixture(fixture);
  }
});

test("R3-P1 renderer: SOFT persistRender does NOT invoke onMaterialized (m0 not advanced)", () => {
  const fixture = makeFixture();
  try {
    // 前置：turn1 HARD 落库。
    ingestTurn(fixture, 1);
    const unitsA = fixture.ingest.ensureUnitsUpTo(SESSION);
    fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsA,
      liveDelta: [],
      hardSignals: HARD_SIGNALS,
    });
    fixture.renderer.persistRender(NOW_MS);
    // 监听器在 SOFT 之前挂上：SOFT persist 不应触发。
    const calls: string[] = [];
    fixture.renderer.onMaterialized = (runtimeSessionId) => {
      calls.push(runtimeSessionId);
    };
    // turn2 新输入 → SOFT（additive state，无 HARD 信号）。
    ingestTurn(fixture, 2);
    const unitsB = fixture.ingest.ensureUnitsUpTo(SESSION);
    const passB = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsB,
      liveDelta: [],
      hardSignals: HARD_SIGNALS,
    });
    assert.equal(passB.record.classification, "SOFT");
    fixture.renderer.persistRender(NOW_MS);
    assert.equal(calls.length, 0, "SOFT must never trigger onMaterialized");
  } finally {
    closeFixture(fixture);
  }
});

test("R3-P1 renderer: SOFT+ persistRender does NOT invoke onMaterialized", () => {
  const fixture = makeFixture();
  try {
    ingestTurn(fixture, 1);
    const unitsA = fixture.ingest.ensureUnitsUpTo(SESSION);
    fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsA,
      liveDelta: [],
      hardSignals: HARD_SIGNALS,
    });
    fixture.renderer.persistRender(NOW_MS);
    const calls: string[] = [];
    fixture.renderer.onMaterialized = (runtimeSessionId) => {
      calls.push(runtimeSessionId);
    };
    // 无新单元 + 同信号 → SOFT+（byte-identical replay）。
    const unitsB = fixture.ingest.ensureUnitsUpTo(SESSION);
    const passB = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsB,
      liveDelta: [],
      hardSignals: HARD_SIGNALS,
    });
    assert.equal(passB.record.classification, "SOFT+");
    fixture.renderer.persistRender(NOW_MS);
    assert.equal(calls.length, 0, "SOFT+ must never trigger onMaterialized");
  } finally {
    closeFixture(fixture);
  }
});

test("R3-P1 renderer: persistRender without a render record is a no-op (no callback)", () => {
  const fixture = makeFixture();
  try {
    let invoked = false;
    fixture.renderer.onMaterialized = () => {
      invoked = true;
    };
    const returned = fixture.renderer.persistRender(NOW_MS);
    assert.equal(returned, undefined, "no render record → no-op");
    assert.equal(invoked, false, "no render record → callback not invoked");
  } finally {
    closeFixture(fixture);
  }
});
