/**
 * Historian Feature B5（Phase D）—— PublicationService + 权威 outbox 测试。
 *
 * 覆盖：事务内 commitBatch（publicationSequence MAX+1、Compartment +
 * outbox 行、HistorianCommitReceiptV1 产出）、provider-neutral 载荷（无
 * Graphiti 字段）、outbox 状态机（claim lease / delivered 绑定 receipt /
 * retry_wait 退避 / quarantined）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { HistorianStore } from "../src/historian/historian-store.js";
import { PublicationService } from "../src/historian/historian-publication.js";
import { buildCompartment } from "../src/historian/historian-compartment.js";
import { historianBatchRangeHash } from "../src/contracts/historian.js";
import { STUB_LINEAGE_ID, simpleUnits } from "./helpers/historian-context-stub.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iris-b5-"));
  const store = HistorianStore.open({
    databasePath: join(dir, "historian.db"),
    nowMs: () => 1_000,
  });
  return { store, dir };
}

function makeBatch() {
  const units = simpleUnits(3);
  const batch = {
    schemaId: "iris.historian_batch.v1" as const,
    batchId: `batch-${STUB_LINEAGE_ID}-1-3`,
    claimId: "claim-1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 3,
    rangeHash: "",
    semanticSchemaIds: ["iris.semantic.context_message.user.v1"],
    units,
    estimatedTokens: 5,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  batch.rangeHash = historianBatchRangeHash(batch);
  return batch;
}

test("B5: commitBatch persists compartment + publication + outbox and emits a receipt", () => {
  const { store, dir } = fixture();
  try {
    const service = new PublicationService({ store, nowMs: () => 1_000 });
    const batch = makeBatch();
    const built = buildCompartment({
      lineageId: STUB_LINEAGE_ID,
      runtimeSessionId: "session-1",
      compartmentSequence: 1,
      units: batch.units,
    });
    assert.ok(built, "compartment built");

    store.begin();
    const receipt = service.commitBatch({
      batch,
      built: built as NonNullable<typeof built>,
      processingProfileId: "profile-1",
      previousProcessedThroughContextSeq: 0,
    });
    store.commit();

    assert.equal(receipt.schemaId, "iris.historian_commit_receipt.v1");
    assert.equal(receipt.batchId, batch.batchId);
    assert.equal(receipt.contextLineageId, STUB_LINEAGE_ID);
    assert.equal(receipt.fromContextSeq, 1);
    assert.equal(receipt.throughContextSeq, 3);
    assert.equal(receipt.rangeHash, batch.rangeHash);
    assert.equal(receipt.compartmentIds.length, 1);
    assert.equal(receipt.publicationIds.length, 1);
    assert.ok(receipt.outputHash.length > 0);

    assert.equal(store.countPublications(), 1);
    assert.equal(store.countOutboxPending(), 1);
    assert.equal(store.maxCompartmentSequence(STUB_LINEAGE_ID), 1);
    // release-state row created for reclaim tracking.
    const views = store.listCompartmentReleaseViews(STUB_LINEAGE_ID);
    assert.equal(views.length, 1);
    assert.equal(views[0]?.publicationSequence, 1);

    const outbox = store
      .raw()
      .prepare("SELECT payload_json, payload_hash, state FROM publication_outbox")
      .all() as unknown as Array<{ payload_json: string; payload_hash: string; state: string }>;
    const payload = JSON.parse(outbox[0]?.payload_json ?? "{}") as Record<string, unknown>;
    assert.equal(payload["schemaId"], "iris.memory_publication.v1");
    assert.equal(payload["processingProfileId"], "profile-1");
    assert.equal(outbox[0]?.state, "pending");
    assert.equal(outbox[0]?.payload_hash, payload["outputHash"]);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("graphiti"), "no graphiti field in provider-neutral payload");
    assert.ok(!serialized.includes("projectionVersion"), "no projectionVersion");
    assert.ok(!serialized.includes("episodeSources"), "no episodeSources");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: publicationSequence is MAX+1 allocated inside the transaction", () => {
  const { store, dir } = fixture();
  try {
    const service = new PublicationService({ store, nowMs: () => 1_000 });
    const batch = makeBatch();
    const built = buildCompartment({
      lineageId: STUB_LINEAGE_ID,
      runtimeSessionId: "s",
      compartmentSequence: 1,
      units: batch.units,
    });
    assert.ok(built, "compartment built");
    store.begin();
    const r1 = service.commitBatch({
      batch,
      built: built,
      processingProfileId: "p",
      previousProcessedThroughContextSeq: 0,
    });
    store.commit();
    store.begin();
    const r2 = service.commitBatch({
      batch: {
        ...batch,
        batchId: "batch-2",
        claimId: "c2",
        fromContextSeq: 4,
        throughContextSeq: 6,
        units: simpleUnits(6).slice(3),
      },
      built: {
        ...built,
        compartment: {
          ...built.compartment,
          compartmentId: `compartment-${STUB_LINEAGE_ID}-2`,
          compartmentSequence: 2,
          startContextSeq: 4,
          endContextSeq: 6,
        },
        attributionManifest: {
          ...built.attributionManifest,
          attributionManifestId: `am-${STUB_LINEAGE_ID}-2`,
        },
      },
      processingProfileId: "p",
      previousProcessedThroughContextSeq: 3,
    });
    store.commit();
    assert.notEqual(r1.publicationIds[0], r2.publicationIds[0], "distinct publication ids");
    const rows = store
      .raw()
      .prepare("SELECT publication_sequence FROM publications ORDER BY publication_sequence")
      .all() as Array<{ publication_sequence: number }>;
    assert.deepEqual(
      rows.map((r) => r.publication_sequence),
      [1, 2],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: outbox claim lease + delivered only with a bound receipt", () => {
  const { store, dir } = fixture();
  try {
    let now = 1_000;
    const service = new PublicationService({ store, nowMs: () => now, claimLeaseMs: 60_000 });
    const batch = makeBatch();
    const built = buildCompartment({
      lineageId: STUB_LINEAGE_ID,
      runtimeSessionId: "s",
      compartmentSequence: 1,
      units: batch.units,
    });
    assert.ok(built, "compartment built");
    store.begin();
    service.commitBatch({
      batch,
      built: built,
      processingProfileId: "p",
      previousProcessedThroughContextSeq: 0,
    });
    store.commit();

    // Claim the row → delivering with a lease.
    const claimed = service.claimBatch({ batchSize: 10 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.state, "delivering");
    assert.ok(claimed[0]?.claimLeasedUntil, "lease attached");
    // Re-claim while the lease is live → nothing (not expired).
    assert.equal(service.claimBatch({ batchSize: 10 }).length, 0);
    // Lease expiry → crashed claim recovered.
    now = 1_000 + 60_001;
    assert.equal(service.claimBatch({ batchSize: 10 }).length, 1, "expired lease re-claimed");

    // Deliver with a receipt bound to the exact publication.
    const publicationId = claimed[0]?.publicationId as string;
    service.markDelivered({
      publicationId,
      receipt: {
        receiptId: "r-1",
        publicationId,
        canonicalPayloadHash: (claimed[0]?.payloadHash ?? "") as string,
        contractVersion: "0.1.0",
      },
    });
    const outboxRow = store
      .raw()
      .prepare("SELECT state FROM publication_outbox WHERE publication_id = ?")
      .get(publicationId) as { state: string };
    assert.equal(outboxRow.state, "delivered");
    // 绑定 receipt 身份持久化在 publications（reclaim 授权面）。
    const pubRow = store
      .raw()
      .prepare(
        "SELECT delivered_receipt_id, delivered_receipt_publication_id, delivered_canonical_payload_hash FROM publications WHERE publication_id = ?",
      )
      .get(publicationId) as {
      delivered_receipt_id: string;
      delivered_receipt_publication_id: string;
      delivered_canonical_payload_hash: string;
    };
    assert.equal(pubRow.delivered_receipt_id, "r-1");
    assert.equal(pubRow.delivered_receipt_publication_id, publicationId);
    assert.equal(pubRow.delivered_canonical_payload_hash, claimed[0]?.payloadHash);
    assert.equal(store.countOutboxPending(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5: outbox retry_wait carries a future backoff lease; quarantine after maxAttempts", () => {
  const { store, dir } = fixture();
  try {
    let now = 1_000;
    const service = new PublicationService({ store, nowMs: () => now, claimLeaseMs: 60_000 });
    const batch = makeBatch();
    const built = buildCompartment({
      lineageId: STUB_LINEAGE_ID,
      runtimeSessionId: "s",
      compartmentSequence: 1,
      units: batch.units,
    });
    assert.ok(built, "compartment built");
    store.begin();
    service.commitBatch({
      batch,
      built: built,
      processingProfileId: "p",
      previousProcessedThroughContextSeq: 0,
    });
    store.commit();
    const claimed = service.claimBatch({ batchSize: 10 });
    const firstClaimed = claimed[0];
    assert.ok(firstClaimed, "claimed row");
    const publicationId = firstClaimed.publicationId;

    service.markFailed({ publicationId, errorCode: "network", maxAttempts: 2 });
    const afterFirst = store
      .raw()
      .prepare(
        "SELECT state, claim_leased_until, attempt_count FROM publication_outbox WHERE publication_id = ?",
      )
      .get(publicationId) as { state: string; claim_leased_until: string; attempt_count: number };
    assert.equal(afterFirst.state, "retry_wait");
    assert.ok(
      Date.parse(afterFirst.claim_leased_until) > now,
      "retry_wait has future backoff lease",
    );
    assert.equal(afterFirst.attempt_count, 1);
    // Backoff gate: no re-claim before lease.
    assert.equal(service.claimBatch({ batchSize: 10 }).length, 0);
    // After lease → re-claim → second failure → quarantined (maxAttempts=2).
    now = 100_000;
    service.claimBatch({ batchSize: 10 });
    service.markFailed({ publicationId, errorCode: "network", maxAttempts: 2 });
    const afterSecond = store
      .raw()
      .prepare("SELECT state, attempt_count FROM publication_outbox WHERE publication_id = ?")
      .get(publicationId) as { state: string; attempt_count: number };
    assert.equal(afterSecond.state, "quarantined");
    assert.equal(afterSecond.attempt_count, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
