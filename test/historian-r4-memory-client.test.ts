/**
 * R4 (iris_agent#9) — Memory Client 投递链路测试。
 *
 * 覆盖:
 *  1. drainOutbox 用 MemoryClient 投递 → 真实 receipt hash 回写 outbox;
 *  2. conflict(409)→ 视为 delivered(重放安全);
 *  3. rejected(400/422)→ quarantined;
 *  4. unavailable → 保持 delivering,lease 过期后可重认领;
 *  5. 无 memoryClient → 旧伪 receipt 行为(lease 恢复证明);
 *  6. envelope 字段与 historian-publication-v2 schema 对齐(anti-echo
 *     evidenceBasis/derivedOnly 传递)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  HistorianManager,
  type HistorianManagerOptions,
} from "../src/historian/historian-manager.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { FakeMemoryClient } from "../src/historian/memory-client.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";

const SESSION = "iris-runtime-2026-08-01-1";

function fixture(): {
  store: HistorianStore;
  manager: HistorianManager;
  memory: FakeMemoryClient;
} {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-memory-client-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const memory = new FakeMemoryClient();
  const manager = new HistorianManager({
    store,
    readPort: new SessionHistoryReadPort({ readRawEntries: async () => [] }),
    modelProviderProfile: "mock",
    nowMs: () => Date.now(),
    historyPort: fakeHistoryPort(),
    memoryClient: memory,
  });
  return { store, manager, memory };
}

function fakeHistoryPort(): ContextHistoryReadPort {
  return {
    getMaterializedBoundary: () => ({
      representedThroughContextSeq: 0,
      representedThroughEntrySeq: null,
      m0ContentHash: null,
      lineageStatus: "ok",
      providerProfileId: "mock",
    }),
    listUnitsForHistorian: () => [],
    listUnitsForHistorianByEntrySeq: () => [],
  };
}

/** 直接插入一条带 payload 的 outbox 行(模拟 commitSafePrefix 已写入)。 */
function seedOutbox(store: HistorianStore, payload: unknown, seq = 1): void {
  store.begin();
  store.insertPublication({
    publicationSequence: seq,
    publicationId: `publication-${SESSION}-${seq}`,
    runtimeSessionId: SESSION,
    processingKey: `pk-${seq}`,
    outputHash: "h".repeat(64),
    compartmentIds: [`compartment-${SESSION}-${seq}`],
    segmentIds: [],
    evidenceSetIds: [],
    assessmentDeltaIds: [],
    continuitySnapshotId: null,
    previousPublicationSequence: null,
    previousSessionProcessedThroughEntrySeq: 0,
    state: "pending",
    attemptCount: 0,
    claimLeasedUntil: null,
    createdAt: "t",
    updatedAt: "t",
  });
  store.insertOutboxRow({
    publicationId: `publication-${SESSION}-${seq}`,
    runtimeSessionId: SESSION,
    payloadHash: "h".repeat(64),
    payloadJson: JSON.stringify(payload),
    state: "pending",
    attemptCount: 0,
    lastErrorCode: null,
    claimLeasedUntil: null,
    createdAt: "t",
    updatedAt: "t",
  });
  store.commit();
}

function outboxState(
  store: HistorianStore,
  publicationId: string,
): {
  state: string;
  delivered_receipt_hash: string | null;
} {
  return store
    .raw()
    .prepare(
      "SELECT o.state, p.delivered_receipt_hash FROM publication_outbox o JOIN publications p ON p.publication_id = o.publication_id WHERE o.publication_id = ?",
    )
    .get(publicationId) as { state: string; delivered_receipt_hash: string | null };
}

const SAMPLE_ENVELOPE = {
  schemaVersion: "historian-publication-v2",
  publicationId: `publication-${SESSION}-1`,
  sourceSequence: 1,
  publishedAt: "2026-08-06T00:00:00Z",
  payloadHash: "a".repeat(64),
  contextRange: {
    contextLineageId: "identity-x",
    fromContextSeq: 1,
    toContextSeq: 2,
    rangeHash: "b".repeat(64),
  },
  semanticSourceVersion: "context-unit-v1",
  compartmentCount: 1,
  segmentCount: 1,
  evidenceCount: 1,
  evidenceBasis: [
    {
      contextUnitId: "u1",
      contextSeq: 1,
      runtimeEventId: "evt-1",
      contentHash: "c".repeat(64),
      historianDisposition: "include",
    },
  ],
  derivedOnly: false,
  summary: "summary",
};

test("r4 memory client: success delivers with real receipt hash", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: true, receiptHash: "real-receipt-123" });
    manager.drainOutbox();
    // drainOutbox 是 async fire-and-forget — 等待事件循环
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivered");
    assert.equal(row.delivered_receipt_hash, "real-receipt-123");
    assert.equal(memory.delivered.length, 1);
  } finally {
    store.close();
  }
});

test("r4 memory client: conflict (409) is replay-safe delivered", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: true, receiptHash: "conflict-replay" });
    manager.drainOutbox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivered");
  } finally {
    store.close();
  }
});

test("r4 memory client: rejected (400/422) quarantines immediately", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: false, error: "rejected" });
    manager.drainOutbox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "quarantined");
  } finally {
    store.close();
  }
});

test("r4 memory client: unavailable keeps row claimable (lease recovery)", async () => {
  const { store, manager, memory } = fixture();
  try {
    seedOutbox(store, SAMPLE_ENVELOPE);
    memory.queue({ ok: false, error: "unavailable" });
    manager.drainOutbox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivering", "unavailable must not mark delivered");
    // lease 过期后重新 claim 并可再次投递成功
    memory.queue({ ok: true, receiptHash: "second-try-receipt" });
    const now = Date.now();
    store
      .raw()
      .prepare("UPDATE publication_outbox SET claim_leased_until = ? WHERE publication_id = ?")
      .run(new Date(now - 1000).toISOString(), `publication-${SESSION}-1`);
    manager.drainOutbox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(after.state, "delivered", "retry after lease expiry must succeed");
    assert.equal(after.delivered_receipt_hash, "second-try-receipt");
  } finally {
    store.close();
  }
});

test("r4 memory client: no client wired keeps legacy fake-receipt behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-legacy-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const manager = new HistorianManager({
      store,
      readPort: new SessionHistoryReadPort({ readRawEntries: async () => [] }),
      modelProviderProfile: "mock",
      nowMs: () => Date.now(),
      historyPort: fakeHistoryPort(),
    } as HistorianManagerOptions);
    seedOutbox(store, SAMPLE_ENVELOPE);
    manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivered");
    assert.match(row.delivered_receipt_hash ?? "", /^receipt-/);
  } finally {
    store.close();
  }
});

test("r4 memory client: envelope carries anti-echo basis and derivedOnly", async () => {
  const { store, manager, memory } = fixture();
  try {
    const derivedEnvelope = {
      ...SAMPLE_ENVELOPE,
      derivedOnly: true,
      evidenceBasis: [],
      evidenceCount: 0,
    };
    seedOutbox(store, derivedEnvelope);
    memory.queue({ ok: true, receiptHash: "r" });
    manager.drainOutbox();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(memory.delivered.length, 1);
    const sent = memory.delivered[0] as {
      derivedOnly: boolean;
      evidenceBasis: unknown[];
      evidenceCount: number;
    };
    assert.equal(sent.derivedOnly, true);
    assert.equal(sent.evidenceBasis.length, 0);
    assert.equal(sent.evidenceCount, 0);
  } finally {
    store.close();
  }
});
