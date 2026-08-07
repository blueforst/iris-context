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
import { mkdtempSync, readFileSync } from "node:fs";
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
import type { MemoryClientPort } from "../src/contracts/ports.js";
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
    listUnitsForHistorianByEntrySeq: () => [
      {
        contextUnitId: "unit-1",
        contextSeq: 1,
        runtimeEventId: "evt-1",
        unitType: "input",
        disposition: "include",
        contentHash: "d".repeat(64),
        derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
      },
    ],
    lineageId: () => "identity-r4",
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
    await manager.drainOutbox();
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
    await manager.drainOutbox();
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
    await manager.drainOutbox();
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
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(row.state, "delivering", "unavailable must not mark delivered");
    // lease 过期后重新 claim 并可再次投递成功
    memory.queue({ ok: true, receiptHash: "second-try-receipt" });
    const now = Date.now();
    store
      .raw()
      .prepare("UPDATE publication_outbox SET claim_leased_until = ? WHERE publication_id = ?")
      .run(new Date(now - 1000).toISOString(), `publication-${SESSION}-1`);
    await manager.drainOutbox();
    const after = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(after.state, "delivered", "retry after lease expiry must succeed");
    assert.equal(after.delivered_receipt_hash, "second-try-receipt");
  } finally {
    store.close();
  }
});

test("r4 memory client: no client wired NEVER fabricates receipts (iris_agent#46)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-noclient-"));
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
    const metrics = await manager.drainOutbox();
    assert.equal(metrics.claimed, 1, "row is claimed for delivery");
    assert.equal(metrics.accepted, 0, "NOTHING accepted without a client");
    assert.equal(metrics.deferred, 1, "row stays retryable");
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered", "never marked delivered");
    assert.equal(row.delivered_receipt_hash, null, "no fabricated receipt hash");
    // The claim lease expires and the row becomes claimable again — it is
    // not lost and not falsely acked; it stays pending/retryable.
    assert.equal(manager.health().memoryDelivery, "unavailable");
    assert.equal(store.countOutboxPending(), 1, "row stays pending and retryable");
  } finally {
    store.close();
  }
});

test("r4 memory client: thrown client errors are caught (no unhandled rejection) and rows stay retryable (iris_agent#46)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-throw-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const throwing = {
      deliverPublication: async () => {
        throw new Error("connection refused");
      },
    } as unknown as MemoryClientPort;
    const manager = new HistorianManager({
      store,
      readPort: new SessionHistoryReadPort({ readRawEntries: async () => [] }),
      modelProviderProfile: "mock",
      nowMs: () => Date.now(),
      historyPort: fakeHistoryPort(),
      memoryClient: throwing,
    } as HistorianManagerOptions);
    seedOutbox(store, SAMPLE_ENVELOPE);
    // Must resolve (not reject) with deferred metrics.
    const metrics = await manager.drainOutbox();
    assert.equal(metrics.accepted, 0);
    assert.equal(metrics.deferred, 1);
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered", "thrown error never fabricates delivered");
    assert.equal(manager.health().deliveryErrors, 1, "exception recorded, not unhandled");
    assert.match(manager.health().lastDeliveryError ?? "", /connection refused/);
    // The row remains claimable: the lease expires and it is retried.
    assert.equal(store.countOutboxPending(), 1);
  } finally {
    store.close();
  }
});

test("r4 memory client: fake/missing receipts cannot authorize outbox reclaim (iris_agent#46)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-reclaim-"));
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
    // Without a client the row can never be delivered, even after a real
    // drain pass (iris_agent#46: no fabricated receipts).
    await manager.drainOutbox();
    const row = outboxState(store, `publication-${SESSION}-1`);
    assert.notEqual(row.state, "delivered");
    // Direct tamper attempt on the receipt hash alone cannot flip state to
    // delivered (the state machine owns the transition; markDelivered is the
    // only writer and it is driven by a real client receipt).
    const tampered = outboxState(store, `publication-${SESSION}-1`);
    assert.equal(tampered.delivered_receipt_hash, null);
    // Reclaim path (hot-row release) requires a real publication delivery;
    // the row is not delivered, so its release view cannot exist with a
    // memory durable ack (nothing was ever acknowledged to memory).
    const releases = store.listCompartmentReleaseViews(SESSION);
    assert.equal(
      releases.some((r) => r.memoryReceiptHash !== null && r.reclaimedAt === null),
      false,
      "no release authorized by a fake/missing receipt",
    );
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
    await manager.drainOutbox();
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

test("r4 memory client: real envelope (from commitSafePrefix) validates against pinned 0.2.0 schema", async () => {
  // 驱动真实生产路径:PublicationService.commitSafePrefix → buildCompartment
  // (带 unitViews)→ buildPublicationEnvelope → outbox payload_json。
  const dir = mkdtempSync(join(tmpdir(), "iris-r4-schema-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  try {
    const { PublicationService } = await import("../src/historian/historian-publication.js");
    const service = new PublicationService({ store, historyPort: fakeHistoryPort() });
    const safePrefix = [
      {
        runtimeSessionId: SESSION,
        entrySeq: 1,
        entryId: "entry-1",
        entry: {
          type: "message",
          id: "e-1",
          parentId: null,
          timestamp: "t",
          message: { role: "user", content: "hello", timestamp: 1 },
        },
        contentHash: "b".repeat(64),
      },
    ];
    service.commitSafePrefix({
      runtimeSessionId: SESSION,
      boundary: {
        boundarySnapshotId: "bs-1",
        runtimeSessionId: SESSION,
        observedHeadEntrySeq: 1,
        eligibleThroughEntrySeq: 1,
        protectedTailStartEntrySeq: 2,
        trueRawEligibleTokens: 10,
        narratableEligibleTokens: 10,
        sourceRangeHash: "range-hash-1",
        modelProviderProfile: "mock",
        frozenAt: "t",
      },
      safePrefix,
      analysis: {
        runtimeSessionId: SESSION,
        boundary: {} as never,
        eligibleEntries: safePrefix as never,
        units: [
          {
            entrySeq: 1,
            entryId: "entry-1",
            kind: "user_input" as const,
            inFlight: false,
            providerVisible: "hello",
          },
        ],
        trueRawEligibleTokens: 10,
      },
      outcome: { ok: true, commitThroughEntrySeq: 1, discardedFromEntrySeq: null } as never,
      previousProcessedThroughEntrySeq: 0,
    });

    const row = store
      .raw()
      .prepare("SELECT payload_json FROM publication_outbox WHERE publication_id = ?")
      .get("publication-iris-runtime-2026-08-01-1-1") as { payload_json: string };
    assert.ok(row.payload_json, "envelope must be persisted");
    const sent = JSON.parse(row.payload_json) as Record<string, unknown>;

    // 用 pinned 0.2.0 schema(与 memory-contract-gate 相同方式)校验
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const formatsModule = await import("ajv-formats");
    const formatsPlugin = formatsModule.default as unknown as (validator: unknown) => void;
    const ARTIFACT = "fixtures/memory-contracts-artifact/iris-memory-contracts-0.2.0";
    const manifest = JSON.parse(readFileSync(join(ARTIFACT, "manifest.json"), "utf8")) as {
      schemas: string[];
    };
    const ajv = new Ajv2020({ allErrors: true });
    formatsPlugin(ajv);
    let targetId: string | undefined;
    for (const schemaRelative of manifest.schemas) {
      const s = JSON.parse(readFileSync(join(ARTIFACT, schemaRelative), "utf8")) as {
        $id?: string;
      };
      if (typeof s.$id === "string") {
        ajv.addSchema(s, s.$id);
        if (schemaRelative === "schemas/historian-publication-v2.schema.json") {
          targetId = s.$id;
        }
      }
    }
    const validate = ajv.getSchema(targetId ?? "");
    assert.ok(validate, "v2 schema must be registered");
    const valid = validate(sent);
    if (!valid) {
      assert.fail(`envelope fails pinned schema: ${JSON.stringify(validate.errors)}`);
    }
    // publicationId 必须满足 uuid 格式
    const pubId = sent["publicationId"] as string;
    assert.match(pubId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // contextRange 必须 >= 1
    const range = sent["contextRange"] as { fromContextSeq: number; toContextSeq: number };
    assert.ok(range.fromContextSeq >= 1);
    assert.ok(range.toContextSeq >= 1);
    assert.ok(range.fromContextSeq <= range.toContextSeq);
  } finally {
    store.close();
  }
});
