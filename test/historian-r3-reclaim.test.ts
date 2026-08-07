import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { HistorianStore } from "../src/historian/historian-store.js";
import {
  deriveShardId,
  eligibleForReclaim,
  isReclaimEligible,
  sealShardContent,
  withBustRepresented,
  withContextAck,
  withMemoryDurableAck,
  withShardVerified,
  type CompartmentReleaseView,
} from "../src/historian/hot-row-reclaim.js";

function view(
  seq: number,
  overrides: Partial<CompartmentReleaseView> = {},
): CompartmentReleaseView {
  return {
    compartmentId: `compartment-s1-${seq}`,
    runtimeSessionId: "s1",
    compartmentSequence: seq,
    startEntrySeq: seq * 10,
    endEntrySeq: seq * 10 + 9,
    publicationSequence: seq,
    contextAckedAt: null,
    bustRepresentedAt: null,
    memoryDurableAckAt: null,
    memoryReceiptHash: null,
    deliveredReceiptId: null,
    deliveredReceiptPublicationId: null,
    deliveredCanonicalPayloadHash: null,
    deliveredContractVersion: null,
    shardId: null,
    shardVerifiedAt: null,
    reclaimedAt: null,
    ...overrides,
  };
}

function storeFixture(): { store: HistorianStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-historian-reclaim-"));
  const path = join(dir, "historian.db");
  return { store: HistorianStore.open({ databasePath: path }), path };
}

test("r3 reclaim: no condition met → not eligible (fail-closed)", () => {
  assert.equal(isReclaimEligible(view(1)), false);
});

test("r3 reclaim: all four conditions met → eligible", () => {
  let v = view(1);
  v = withContextAck(v, "2026-08-05T00:00:01Z");
  v = withBustRepresented(v, "2026-08-05T00:00:02Z");
  v = withMemoryDurableAck(v, "2026-08-05T00:00:03Z", "receipt-hash-1");
  v = {
    ...v,
    deliveredReceiptId: "receipt-hash-1",
    deliveredReceiptPublicationId: "pub-1",
    deliveredCanonicalPayloadHash: "h".repeat(64),
    deliveredContractVersion: "0.2.0",
  };
  v = withShardVerified(v, "shard-s1-1", "2026-08-05T00:00:04Z");
  assert.equal(isReclaimEligible(v), true);
});

test("r3 reclaim: missing ANY single condition blocks release", () => {
  // 缺 context ack
  let v = view(1);
  v = withBustRepresented(v, "t2");
  v = withMemoryDurableAck(v, "t3", "receipt");
  v = {
    ...v,
    deliveredReceiptId: "receipt",
    deliveredReceiptPublicationId: "pub-1",
    deliveredCanonicalPayloadHash: "h".repeat(64),
    deliveredContractVersion: "0.2.0",
  };
  v = withShardVerified(v, "shard", "t4");
  assert.equal(isReclaimEligible(v), false);

  // 缺 memory receipt hash(durable ACK 无凭据)
  v = view(1);
  v = withContextAck(v, "t1");
  v = withBustRepresented(v, "t2");
  v = withMemoryDurableAck(v, "t3", "");
  v = withShardVerified(v, "shard", "t4");
  assert.equal(isReclaimEligible(v), false);

  // 缺 shard verified
  v = view(1);
  v = withContextAck(v, "t1");
  v = withBustRepresented(v, "t2");
  v = withMemoryDurableAck(v, "t3", "receipt");
  v = {
    ...v,
    deliveredReceiptId: "receipt",
    deliveredReceiptPublicationId: "pub-1",
    deliveredCanonicalPayloadHash: "h".repeat(64),
    deliveredContractVersion: "0.2.0",
  };
  assert.equal(isReclaimEligible(v), false);

  // 已 reclaimed → 不再 eligible
  v = view(1);
  v = withContextAck(v, "t1");
  v = withBustRepresented(v, "t2");
  v = withMemoryDurableAck(v, "t3", "receipt");
  v = {
    ...v,
    deliveredReceiptId: "receipt",
    deliveredReceiptPublicationId: "pub-1",
    deliveredCanonicalPayloadHash: "h".repeat(64),
    deliveredContractVersion: "0.2.0",
  };
  v = withShardVerified(v, "shard", "t4");
  v = { ...v, reclaimedAt: "t5" };
  assert.equal(isReclaimEligible(v), false);
});

test("r3 reclaim: eligibleForReclaim deterministic ascending order", () => {
  const views = [
    view(3, {
      contextAckedAt: "t",
      bustRepresentedAt: "t",
      memoryDurableAckAt: "t",
      memoryReceiptHash: "h",
      deliveredReceiptId: "r3",
      deliveredReceiptPublicationId: "pub-3",
      deliveredCanonicalPayloadHash: "h".repeat(64),
      deliveredContractVersion: "0.2.0",
      shardVerifiedAt: "t",
    }),
    view(1),
    view(2, {
      contextAckedAt: "t",
      bustRepresentedAt: "t",
      memoryDurableAckAt: "t",
      memoryReceiptHash: "h",
      deliveredReceiptId: "r2",
      deliveredReceiptPublicationId: "pub-2",
      deliveredCanonicalPayloadHash: "h".repeat(64),
      deliveredContractVersion: "0.2.0",
      shardVerifiedAt: "t",
    }),
  ];
  const eligible = eligibleForReclaim(views);
  assert.deepEqual(
    eligible.map((v) => v.compartmentSequence),
    [2, 3],
  );
});

test("r3 reclaim: shard seal content is deterministic and covers receipt hashes", () => {
  const a = sealShardContent("s1", [view(1), view(2)], 2);
  const b = sealShardContent("s1", [view(2), view(1)], 2);
  assert.equal(a, b, "seal content must be order-insensitive-deterministic");
  assert.ok(a.includes("historian-shard-v1"));
  assert.ok(a.includes("compartment-s1-1"));
});

test("r3 reclaim: deriveShardId stable", () => {
  assert.equal(deriveShardId("s1", 1), "shard-s1-1");
  assert.equal(deriveShardId("s1", 1), deriveShardId("s1", 1));
});

test("r3 reclaim: store round-trip — ack progression then reclaim deletes hot rows", () => {
  const { store, path } = storeFixture();
  try {
    let v = view(1);
    store.upsertCompartmentRelease(v);

    // iris_agent#64: reclaim authorization needs the VERIFIED bound receipt
    // persisted on the publications row (JOINed in the release view), so
    // seed a delivered publication with its receipt binding.
    store.begin();
    store.insertPublication({
      publicationSequence: 1,
      publicationId: "pub-1",
      runtimeSessionId: "s1",
      processingKey: "pk-1",
      outputHash: "h".repeat(64),
      compartmentIds: ["compartment-s1-1"],
      segmentIds: [],
      evidenceSetIds: [],
      assessmentDeltaIds: [],
      continuitySnapshotId: null,
      previousPublicationSequence: null,
      previousSessionProcessedThroughEntrySeq: 0,
      state: "delivered",
      attemptCount: 0,
      claimLeasedUntil: null,
      createdAt: "t",
      updatedAt: "t",
    });
    store.commit();
    store
      .raw()
      .prepare(
        `UPDATE publications SET
           delivered_at = '2026-08-05T00:00:03Z',
           delivered_receipt_hash = ?,
           delivered_receipt_id = ?,
           delivered_receipt_schema_version = 'acceptance-receipt-v1',
           delivered_receipt_publication_id = 'pub-1',
           delivered_canonical_payload_hash = ?,
           delivered_contract_version = '0.2.0',
           delivered_duplicate_replay = 0
         WHERE publication_id = 'pub-1'`,
      )
      .run("receipt-abc", "receipt-abc", "h".repeat(64));

    // 进度:Context ACK → bust → memory durable ACK → shard verified
    v = withContextAck(v, "2026-08-05T00:00:01Z");
    store.upsertCompartmentRelease(v);
    v = withBustRepresented(v, "2026-08-05T00:00:02Z");
    store.upsertCompartmentRelease(v);
    v = withMemoryDurableAck(v, "2026-08-05T00:00:03Z", "receipt-abc");
    store.upsertCompartmentRelease(v);
    v = withShardVerified(v, "shard-s1-1", "2026-08-05T00:00:04Z");
    store.upsertCompartmentRelease(v);

    const views = store.listCompartmentReleaseViews("s1");
    assert.equal(views.length, 1);
    const first = views[0];
    assert.ok(first);
    assert.equal(isReclaimEligible(first), true);
    assert.equal(first.memoryReceiptHash, "receipt-abc");
    assert.equal(first.deliveredReceiptId, "receipt-abc", "bound receipt JOINed");
    assert.equal(first.deliveredReceiptPublicationId, "pub-1");

    // 插入模拟 hot rows(compartment + evidence),reclaim 后应删除
    store.begin();
    store.insertCompartment({
      compartmentId: "compartment-s1-1",
      runtimeSessionId: "s1",
      compartmentSequence: 1,
      startEntrySeq: 10,
      endEntrySeq: 19,
      sourceRangeHash: "hash-1",
      content: "content-1",
      p1: "",
      p2: "",
      p3: "",
      p4: "",
      importance: "medium",
      episodeType: "request_response",
      attributionManifestId: "am-s1-1",
      publicationSequence: 1,
    });
    store.insertEvidenceSet({
      evidenceSetId: "evidence-s1-1",
      runtimeSessionId: "s1",
      compartmentId: "compartment-s1-1",
      startEntrySeq: 10,
      endEntrySeq: 19,
      sourceRangeHash: "hash-1",
      entries: [],
    });
    store.commit();

    store.begin();
    store.deleteReclaimedHotRows("s1", "compartment-s1-1");
    store.markReclaimed("compartment-s1-1", "2026-08-05T00:00:05Z");
    store.commit();

    assert.equal(store.countReclaimed(), 1);
    assert.equal(
      store.listCompartmentReleaseViews("s1").length,
      0,
      "reclaimed views disappear from pending list",
    );
    // 物理删除验证:重新打开后 compartments 表无该行
    store.close();
    const reopened = HistorianStore.open({ databasePath: path });
    const remaining = reopened
      .raw()
      .prepare("SELECT COUNT(*) AS c FROM compartments WHERE compartment_id = ?")
      .get("compartment-s1-1") as { c: number };
    assert.equal(remaining.c, 0, "compartment hot row must be physically deleted");
    reopened.close();
  } finally {
    store.close();
  }
});

test("r3 reclaim: store persists shard catalog", () => {
  const { store } = storeFixture();
  try {
    store.insertArchiveShard({
      shardId: "shard-s1-1",
      runtimeSessionId: "s1",
      firstCompartmentSequence: 1,
      lastCompartmentSequence: 5,
      shardPath: "archives/historian/s1/shard-1.json",
      sha256: "a".repeat(64),
      rowCount: 5,
    });
    const row = store
      .raw()
      .prepare("SELECT sha256, row_count FROM archive_shards WHERE shard_id = ?")
      .get("shard-s1-1") as { sha256: string; row_count: number };
    assert.equal(row.sha256, "a".repeat(64));
    assert.equal(row.row_count, 5);
  } finally {
    store.close();
  }
});

test("r3 reclaim: active hot count reaches plateau (no linear growth)", () => {
  const { store } = storeFixture();
  try {
    // 模拟 100 个 compartment 全部四条件满足 → 全部 reclaim → active = 0
    for (let i = 1; i <= 100; i++) {
      let v = view(i);
      v = withContextAck(v, "t1");
      v = withBustRepresented(v, "t2");
      v = withMemoryDurableAck(v, "t3", `receipt-${i}`);
      v = withShardVerified(v, `shard-s1-${i}`, "t4");
      store.upsertCompartmentRelease(v);
    }
    assert.equal(store.countActiveCompartments("s1"), 100);
    // 全部 reclaim
    for (const v of store.listCompartmentReleaseViews("s1")) {
      store.begin();
      store.deleteReclaimedHotRows("s1", v.compartmentId);
      store.markReclaimed(v.compartmentId, "t5");
      store.commit();
    }
    assert.equal(store.countActiveCompartments("s1"), 0);
    assert.equal(store.countReclaimed(), 100);
  } finally {
    store.close();
  }
});
