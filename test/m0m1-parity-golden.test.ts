import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { ContextIngest } from "../src/context/context-ingest.js";
import {
  ContextRenderer,
  rebuildM0Body,
  renderHistorySince,
  syntheticUserMessage,
} from "../src/context/context-renderer.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  LKG_UNITS_SLOT_KEY,
  captureUnitsLkg,
  replayUnitsLkg,
  verifyUnitsLkg,
} from "../src/context/lkg-units.js";
import { M0_EMPTY_BODY, M1_EMPTY_PLACEHOLDER } from "../src/contracts/context.js";
import type { PiSeamEvent } from "../src/contracts/runtime-events.js";
import { transformContextMessages } from "../src/runtime/context-adapter.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  encodeInputFrames,
} from "../src/runtime/companion.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";
import { runMinimalSlice, sampleAgentInput } from "../src/runtime/vertical-slice.js";

/**
 * R2-P1 m0/m1 golden parity gate（Roadmap v13 canonical chain 的 Provider
 * Renderer 验收）。
 *
 * 场景（直接驱动 ContextIngest + ContextRenderer，确定性，无时钟依赖）：
 *   Pass A  turn1 first_render HARD：units=[] → m0=M0_EMPTY_BODY、
 *          m1=M1_EMPTY_PLACEHOLDER；
 *   Pass B  turn2 SOFT+：字节不变回放（与 Pass A 渲染逐字节一致）；
 *   Pass C  turn3 新用户输入 SOFT：m1 = renderHistorySince（冻结 golden 字节）；
 *   Pass D  turn4 model_change HARD：重建 m0（fold m1）、cached_m0_model_key
 *          bust。
 *
 * 同时断言结构不变量：m0/m1 是两个头部 synthetic user 消息（role user，
 * content 分别包裹 <session-history>/<session-history-since>），绝不包含
 * IRIS_INPUT_V1 wire 或 iris_input_meta companion。
 */

const SESSION = "iris-runtime-2026-08-01-1";
const NOW_MS = 1_785_000_000_000;

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

const HARD_SIGNALS_A = {
  modelKey: "mock-iris:mock-deepseek-v4-flash",
  systemHash: "sys-hash-1",
  providerProfileId: "mock",
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

let eventOrdinal = 0;

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
  return JSON.stringify({
    role: "user",
    content: encodeInputFrames(sampleAgentInput().blocks),
    timestamp: 1_700_000_000_000,
  });
}

/** 真实 companion（createInputMetaCompanion + 真实 layout hash → 验证通过）。 */
function realCompanionWire(): string {
  const input = sampleAgentInput();
  const wire = encodeInputFrames(input.blocks);
  const layoutHash = computeContentLayoutHash(input, wire);
  return JSON.stringify(createInputMetaCompanion(input, layoutHash, "2026-08-01T00:00:00.000Z", 1));
}

function assistantWire(text: string): string {
  return JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "opencode",
    provider: "opencode",
    model: "deepseek-v4-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_700_000_000_001,
  });
}

interface Fixture {
  dir: string;
  store: ContextStore;
  ledger: RuntimeEventLedger;
  ingest: ContextIngest;
  renderer: ContextRenderer;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "iris-m0m1-golden-"));
  const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
  const store = ContextStore.open(join(dir, "context.db"));
  store.createLineage(makeLineageInput());
  const ingest = new ContextIngest(ledger, store);
  const renderer = new ContextRenderer(store);
  return { dir, store, ledger, ingest, renderer };
}

function closeFixture(fixture: Fixture): void {
  fixture.store.close();
  fixture.ledger.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

/** 结构不变量：两个头部 synthetic user 消息，content 包 <session-history>。 */
function contentOf(message: AgentMessage): unknown {
  return (message as { content?: unknown }).content;
}

/** 取数组下标消息并窄化（lint：禁用 `!` 与 `as` 断言，用提前返回收窄）。 */
function expectMessage(messages: AgentMessage[], index: number): AgentMessage {
  const message = messages[index];
  if (message === undefined) {
    throw new Error(`expected message at index ${index}`);
  }
  return message;
}

function assertHeadMessages(
  messages: AgentMessage[],
  expectedM0: string,
  expectedM1: string,
): void {
  const m0 = messages[0];
  const m1 = messages[1];
  assert.ok(m0, "messages must have an m0 head");
  assert.ok(m1, "messages must have an m1 head");
  assert.equal(m0.role, "user", "m0 is a synthetic user message");
  assert.equal(m1.role, "user", "m1 is a synthetic user message");
  assert.equal(typeof contentOf(m0), "string", "m0 content must be plain text");
  assert.equal(typeof contentOf(m1), "string", "m1 content must be plain text");
  assert.equal(contentOf(m0), expectedM0);
  assert.equal(contentOf(m1), expectedM1);
  assert.match(String(contentOf(m0)), /^<session-history>/);
  assert.match(String(contentOf(m1)), /^<session-history-since>/);
  for (const message of [m0, m1]) {
    const text = String(contentOf(message));
    assert.ok(!text.includes("IRIS_INPUT_V1"), "synthetic head never leaks raw wire");
    assert.ok(!text.includes("iris_input_meta"), "synthetic head never leaks companion");
  }
}

test("r2-p1: golden — turn1 first_render HARD materializes M0_EMPTY_BODY + placeholder", () => {
  const fixture = makeFixture();
  try {
    const units = fixture.ingest.ensureUnitsUpTo(SESSION);
    assert.deepEqual(units, [], "first controller call sees an empty session");
    const { messages, record } = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units,
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    assert.equal(record.classification, "HARD");
    assert.equal(record.reason, "first_render");
    assert.equal(record.m0Body, M0_EMPTY_BODY);
    assert.equal(record.m1Body, M1_EMPTY_PLACEHOLDER);
    assert.equal(record.representedThroughContextSeq, 0);
    assertHeadMessages(messages, M0_EMPTY_BODY, M1_EMPTY_PLACEHOLDER);
    assert.equal(messages.length, 2, "no p5Tail / liveDelta on an empty session");

    fixture.renderer.persistRender(NOW_MS);
    const lineage = fixture.store.getLineage(SESSION);
    assert.equal(lineage?.m0Body, M0_EMPTY_BODY);
    assert.equal(lineage?.m1Body, M1_EMPTY_PLACEHOLDER);
    assert.equal(lineage?.m0ContentHash, sha256(M0_EMPTY_BODY));
    assert.equal(lineage?.representedThroughContextSeq, 0);
    assert.equal(lineage?.cachedM0ModelKey, HARD_SIGNALS_A.modelKey);
  } finally {
    closeFixture(fixture);
  }
});

test("r2-p1: golden — turn2 SOFT+ replays m0/m1 byte-identically (no new units)", () => {
  const fixture = makeFixture();
  try {
    // Pass A：first_render HARD（与上一测试相同的前置）。
    const unitsA = fixture.ingest.ensureUnitsUpTo(SESSION);
    const passA = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsA,
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    assert.equal(passA.record.classification, "HARD");
    fixture.renderer.persistRender(NOW_MS);

    // Pass B：无新内容 → SOFT+，m0/m1 逐字节一致。
    const unitsB = fixture.ingest.ensureUnitsUpTo(SESSION);
    assert.deepEqual(unitsB, [], "no new content on turn2");
    const passB = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsB,
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    assert.equal(passB.record.classification, "SOFT+");
    assert.equal(passB.record.m0Body, M0_EMPTY_BODY);
    assert.equal(passB.record.m1Body, M1_EMPTY_PLACEHOLDER);
    assert.deepEqual(
      passB.messages,
      passA.messages,
      "SOFT+ must replay byte-identical m0/m1 messages",
    );
    assertHeadMessages(passB.messages, M0_EMPTY_BODY, M1_EMPTY_PLACEHOLDER);
  } finally {
    closeFixture(fixture);
  }
});

test("r2-p1: golden — turn3 SOFT renders m1 as <session-history-since> and advances watermark", () => {
  const fixture = makeFixture();
  try {
    // Pass A：first_render HARD。
    fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: fixture.ingest.ensureUnitsUpTo(SESSION),
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    fixture.renderer.persistRender(NOW_MS);

    // turn3 新用户输入：user + companion（折叠）+ assistant。
    fixture.ledger.ingest(
      sampleEvent({ entryId: "user-3", role: "user", payload: userMessageWire() }),
    );
    fixture.ledger.ingest(
      sampleEvent({ entryId: "comp-3", role: "custom", payload: realCompanionWire() }),
    );
    fixture.ledger.ingest(
      sampleEvent({
        entryId: "assistant-3",
        role: "assistant",
        payload: assistantWire("the answer is 42"),
      }),
    );
    const unitsC = fixture.ingest.ensureUnitsUpTo(SESSION);
    assert.equal(unitsC.length, 2, "user folded + assistant = 2 units");
    const passC = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsC,
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    assert.equal(passC.record.classification, "SOFT", "additive state → SOFT, never HARD");
    assert.equal(passC.record.m0Body, M0_EMPTY_BODY, "m0 must stay byte-identical on SOFT");

    // 冻结 golden 字节（首次正确运行捕获；与 renderHistorySince 自洽）。
    // 注意 sourceLabel 的 channel 保持原样（小写 cli），不做 toUpperCase。
    const expectedM1 = [
      "<session-history-since>",
      "[history since context_seq 1..2]",
      "[user 1] [USER | cli | USER REQUEST | LIMITED]",
      "hello iris, run the read tool",
      "[assistant 2] the answer is 42",
      "</session-history-since>",
    ].join("\n");
    assert.equal(renderHistorySince(unitsC), expectedM1, "golden bytes frozen");
    assert.equal(passC.record.m1Body, expectedM1);

    // messages = [m0, m1, ...p5Tail]；p5Tail = representedThrough 之后的单元。
    assert.equal(passC.messages.length, 4);
    assertHeadMessages(passC.messages, M0_EMPTY_BODY, expectedM1);
    assert.equal(passC.messages[2], unitsC[0]?.payload, "p5Tail carries the folded input");
    assert.equal(passC.messages[3], unitsC[1]?.payload, "p5Tail carries the assistant");

    fixture.renderer.persistRender(NOW_MS);
    const lineage = fixture.store.getLineage(SESSION);
    assert.equal(lineage?.m1Body, expectedM1);
    assert.equal(lineage?.m1ContentHash, sha256(expectedM1));
    assert.equal(lineage?.m0Body, M0_EMPTY_BODY, "SOFT must never touch m0");
    assert.equal(lineage?.representedThroughContextSeq, 2, "watermark advances to max rendered");
  } finally {
    closeFixture(fixture);
  }
});

test("r2-p1: golden — turn4 model_change HARD rebuilds m0 and busts cached_m0_model_key", () => {
  const fixture = makeFixture();
  try {
    // Pass A：first_render HARD。
    fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: fixture.ingest.ensureUnitsUpTo(SESSION),
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    fixture.renderer.persistRender(NOW_MS);

    // turn3 累积 2 个单元。
    fixture.ledger.ingest(
      sampleEvent({ entryId: "user-3", role: "user", payload: userMessageWire() }),
    );
    fixture.ledger.ingest(
      sampleEvent({ entryId: "comp-3", role: "custom", payload: realCompanionWire() }),
    );
    fixture.ledger.ingest(
      sampleEvent({
        entryId: "assistant-3",
        role: "assistant",
        payload: assistantWire("the answer is 42"),
      }),
    );
    const unitsC = fixture.ingest.ensureUnitsUpTo(SESSION);
    assert.equal(unitsC.length, 2);
    fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsC,
      liveDelta: [],
      hardSignals: HARD_SIGNALS_A,
    });
    fixture.renderer.persistRender(NOW_MS);

    // turn4：model_change → HARD。m0 重建（fold m1），cached model key bust。
    const hardB = { ...HARD_SIGNALS_A, modelKey: "mock-iris:model-v2" };
    const passD = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units: unitsC,
      liveDelta: [],
      hardSignals: hardB,
    });
    assert.equal(passD.record.classification, "HARD");
    assert.equal(passD.record.reason, "model_change");
    const expectedM0 = rebuildM0Body(unitsC, 2);
    assert.match(expectedM0, /^<session-history>/);
    assert.notEqual(expectedM0, M0_EMPTY_BODY, "rebuilt m0 folds the accumulated units");
    assert.equal(passD.record.m0Body, expectedM0);
    assert.equal(passD.record.m1Body, M1_EMPTY_PLACEHOLDER, "m1 folded into m0 → reset");
    assertHeadMessages(passD.messages, expectedM0, M1_EMPTY_PLACEHOLDER);

    fixture.renderer.persistRender(NOW_MS);
    const lineage = fixture.store.getLineage(SESSION);
    assert.equal(lineage?.m0Body, expectedM0);
    assert.equal(lineage?.m0ContentHash, sha256(expectedM0));
    assert.equal(lineage?.m1Body, M1_EMPTY_PLACEHOLDER);
    assert.equal(lineage?.cachedM0ModelKey, "mock-iris:model-v2", "cached model key bust");
    assert.equal(lineage?.cachedM0SystemHash, HARD_SIGNALS_A.systemHash);
    assert.equal(lineage?.representedThroughContextSeq, 2);
  } finally {
    closeFixture(fixture);
  }
});

test("r2-p1: renderProviderMessages orders [m0, m1, ...p5Tail, ...liveDelta]", () => {
  const fixture = makeFixture();
  try {
    fixture.ledger.ingest(
      sampleEvent({ entryId: "user-1", role: "user", payload: userMessageWire() }),
    );
    fixture.ledger.ingest(
      sampleEvent({ entryId: "comp-1", role: "custom", payload: realCompanionWire() }),
    );
    const units = fixture.ingest.ensureUnitsUpTo(SESSION);
    assert.equal(units.length, 1);
    const liveDelta: AgentMessage[] = [{ role: "user", content: "live steer", timestamp: 1 }];
    const pass = fixture.renderer.renderForProviderCall({
      runtimeSessionId: SESSION,
      units,
      liveDelta,
      hardSignals: HARD_SIGNALS_A,
    });
    // HARD first_render（lineage 未物化）：fold 后新单元仍是 p5Tail。
    assert.equal(pass.record.classification, "HARD");
    assert.equal(pass.messages.length, 4);
    assertHeadMessages(pass.messages, M0_EMPTY_BODY, renderHistorySince(units));
    assert.equal(pass.messages[2], units[0]?.payload, "p5Tail before liveDelta");
    assert.equal(pass.messages[3], liveDelta[0], "liveDelta after p5Tail");
  } finally {
    closeFixture(fixture);
  }
});

test("r2-p1: transformContextMessages never double-folds the synthetic m0/m1 head", () => {
  const m0 = syntheticUserMessage(M0_EMPTY_BODY);
  const m1 = syntheticUserMessage(M1_EMPTY_PLACEHOLDER);
  const input = sampleAgentInput();
  const steerWire = encodeInputFrames(input.blocks);
  const steerUser: AgentMessage = { role: "user", content: steerWire, timestamp: 1 };
  const companion = createInputMetaCompanion(
    input,
    computeContentLayoutHash(input, steerWire),
    "2026-08-01T00:00:00.000Z",
    1,
  );
  const result = transformContextMessages({
    invocationId: "inv-1",
    runtimeSessionId: SESSION,
    messages: [m0, m1, steerUser, companion],
    model: { provider: "mock-iris", modelId: "mock-deepseek-v4-flash" },
    providerProfileId: "mock",
  });
  assert.equal(result.messages.length, 3, "m0 + m1 + folded steer (companion stripped)");
  assert.equal(
    contentOf(expectMessage(result.messages, 0)),
    M0_EMPTY_BODY,
    "m0 passes through unchanged",
  );
  assert.equal(
    contentOf(expectMessage(result.messages, 1)),
    M1_EMPTY_PLACEHOLDER,
    "m1 passes through unchanged",
  );
  // 折叠后的 steer 是 text part 数组（transformContextMessages 的折叠形状），
  // 文本内容必须来自 IRIS_INPUT_V1 wire，且 m0/m1 未被二次折叠。
  const folded = contentOf(expectMessage(result.messages, 2));
  const foldedText = Array.isArray(folded)
    ? (folded as Array<{ type?: string; text?: string }>)
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("\n")
    : String(folded);
  assert.ok(foldedText.includes("hello iris"), "only the steer pair is folded");
});

test("r2-p1: lkg-units capture → verify → replay captured prefix + live delta, never synthetic repair", () => {
  const fixture = makeFixture();
  try {
    const m0Body = "<session-history>golden baseline</session-history>";
    const m1Body = M1_EMPTY_PLACEHOLDER;
    const prefixMessages: AgentMessage[] = [
      syntheticUserMessage(m0Body),
      syntheticUserMessage(m1Body),
    ];
    const fingerprint = {
      systemHash: "sys-hash-1",
      m0ContentHash: sha256(m0Body),
      m1ContentHash: sha256(m1Body),
      representedThroughContextSeq: 1,
    };

    // 捕获。
    const captured = captureUnitsLkg(fixture.store, {
      runtimeSessionId: SESSION,
      ...fingerprint,
      m0Body,
      m1Body,
      prefixMessages,
      modelKey: "mock-iris:mock-deepseek-v4-flash",
      providerKey: "mock-iris",
      capturedAt: 1_000,
    });
    assert.equal(captured, true);
    const slot = fixture.store.getLkgSlot(SESSION, LKG_UNITS_SLOT_KEY);
    assert.ok(slot, "slot persisted");

    // 验证 OK。
    assert.equal(verifyUnitsLkg(fixture.store, { runtimeSessionId: SESSION, fingerprint }), true);

    // 强制 provider 失败：回放 = 捕获前缀 + 原始 live delta，无 synthetic repair。
    const liveDelta: AgentMessage[] = [
      { role: "user", content: "steer after failure", timestamp: 1 },
    ];
    const replayed = replayUnitsLkg(fixture.store, {
      runtimeSessionId: SESSION,
      fingerprint,
      liveDelta,
    });
    assert.ok(replayed.ok, "fingerprint matches → replay allowed");
    if (replayed.ok) {
      assert.deepEqual(
        replayed.messages,
        [...prefixMessages, ...liveDelta],
        "fallback is exactly the captured prefix + raw live delta",
      );
    }

    // 指纹不匹配 → 类型化失败（绝不回放/绝不合成修复）。
    const mismatched = replayUnitsLkg(fixture.store, {
      runtimeSessionId: SESSION,
      fingerprint: { ...fingerprint, systemHash: "sys-hash-2" },
      liveDelta: [],
    });
    assert.deepEqual(mismatched, { ok: false, reason: "lkg_units_fingerprint_mismatch" });

    // 槽缺失 → 类型化失败。
    const missing = replayUnitsLkg(fixture.store, {
      runtimeSessionId: "no-such-session",
      fingerprint,
      liveDelta: [],
    });
    assert.deepEqual(missing, { ok: false, reason: "lkg_units_missing" });

    // 同 key 不同指纹的重新捕获被拒绝（不覆盖已失效槽）。
    assert.equal(
      captureUnitsLkg(fixture.store, {
        runtimeSessionId: SESSION,
        ...fingerprint,
        systemHash: "sys-hash-2",
        m0Body: m0Body,
        m1Body: m1Body,
        prefixMessages,
        modelKey: "mock-iris:mock-deepseek-v4-flash",
        providerKey: "mock-iris",
      }),
      false,
      "must not overwrite a slot with a different fingerprint",
    );
  } finally {
    closeFixture(fixture);
  }
});

test("r2-p1: runMinimalSlice persists m0/m1 and the provider snapshot starts with the synthetic head", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-m0m1-slice-"));
  try {
    const result = await runMinimalSlice({ dataRoot, now: "2026-08-01T00:00:00.000Z" });
    // 第一次 provider call 的 fold 在空 session 上 → m0 保持 M0_EMPTY_BODY；
    // m1 覆盖当轮 live 单元的 session-history-since。
    assert.equal(result.m0Body, M0_EMPTY_BODY);
    assert.match(result.m1Body, /^<session-history-since>/);
    assert.ok(result.representedThroughContextSeq >= 1);

    for (const snapshot of result.observers.providerContextSnapshots) {
      assert.ok(!snapshot.includes("IRIS_INPUT_V1"), "never leaks raw wire to the provider");
      assert.ok(!snapshot.includes("iris_input_meta"), "never leaks companions to the provider");
    }

    const first = JSON.parse(
      result.observers.providerContextSnapshots[0] ?? "[]",
    ) as AgentMessage[];
    const head0 = expectMessage(first, 0);
    const head1 = expectMessage(first, 1);
    assert.equal(head0.role, "user");
    assert.match(String(contentOf(head0)), /^<session-history>/);
    assert.equal(contentOf(head0), M0_EMPTY_BODY);
    assert.equal(head1.role, "user");
    assert.match(String(contentOf(head1)), /^<session-history-since>/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
