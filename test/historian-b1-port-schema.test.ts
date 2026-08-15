/**
 * Historian Feature B1（Phase D）—— historian.db schema + store 测试。
 *
 * 覆盖：空库初始化 0001-0011、幂等重开、checksum fail-closed、newer-schema
 * fail-closed、session state / lineage cursor / batch claim-commit-receipt
 * round-trip、事务 begin/commit/rollback。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { HistorianStore } from "../src/historian/historian-store.js";
import { migrateDatabase } from "../src/db/migrate.js";
import {
  newClaimId,
  newReceiptId,
  type HistorianCommitReceiptV1,
} from "../src/contracts/historian.js";
import { simpleUnits, STUB_LINEAGE_ID } from "./helpers/historian-context-stub.js";

const SESSION = "iris-runtime-2026-08-01-1";

function storeFixture(): { store: HistorianStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "iris-b1-store-"));
  const path = join(dir, "historian.db");
  const store = HistorianStore.open({ databasePath: path });
  return { store, dir, path };
}

function makeBatch(from = 1, through = 3) {
  const units = simpleUnits(through);
  const batch = {
    schemaId: "iris.historian_batch.v2" as const,
    batchId: `batch-${STUB_LINEAGE_ID}-${from}-${through}`,
    claimId: newClaimId(),
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: "rh-1",
    semanticSchemaIds: ["iris.semantic.context_message.user.v1"],
    units,
    estimatedTokens: 10,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  return batch;
}

function makeReceipt(batchId: string, claimId: string): HistorianCommitReceiptV1 {
  return {
    schemaId: "iris.historian_commit_receipt.v1",
    receiptId: newReceiptId(batchId, claimId),
    batchId,
    claimId,
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 3,
    rangeHash: "rh-1",
    compartmentIds: [`compartment-${STUB_LINEAGE_ID}-1`],
    publicationIds: ["publication-1"],
    outputHash: "oh-1",
    committedAt: "2026-08-01T00:00:01.000Z",
  };
}

test("B1: HistorianStore migrates an empty data root through 0001-0011", () => {
  const { store, dir } = storeFixture();
  try {
    const tables = store
      .raw()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    for (const required of [
      "session_state",
      "boundary_snapshots",
      "compartments",
      "publications",
      "publication_outbox",
      "lineage_cursors",
      "compartment_release_state",
      "archive_shards",
      "historian_batches",
    ]) {
      assert.ok(names.has(required), `table ${required} exists`);
    }
    // v27/v29 废止表已删除。
    for (const dropped of [
      "continuity_snapshots",
      "memory_assessment_deltas",
      "segments",
      "evidence_sets",
    ]) {
      assert.ok(!names.has(dropped), `table ${dropped} dropped`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: migration is idempotent on repeat open; checksum verified; newer schema fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b1-idem-"));
  const path = join(dir, "historian.db");
  const migrationsDir = join("src", "db", "migrations", "historian");
  try {
    const first = migrateDatabase(path, migrationsDir);
    assert.ok(first.appliedVersions.length >= 11, `first run applies pending migrations`);
    assert.equal(
      migrateDatabase(path, migrationsDir).appliedVersions.length,
      0,
      "repeat idempotent",
    );
    assert.equal(
      migrateDatabase(path, migrationsDir).appliedVersions.length,
      0,
      "third idempotent",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const dir2 = mkdtempSync(join(tmpdir(), "iris-b1-checksum-"));
  const path2 = join(dir2, "historian.db");
  const migDir = join(dir2, "migrations");
  mkdirSync(migDir, { recursive: true });
  writeFileSync(join(migDir, "0001_bootstrap.sql"), "CREATE TABLE t (id INTEGER PRIMARY KEY);\n");
  migrateDatabase(path2, migDir);
  writeFileSync(
    join(migDir, "0001_bootstrap.sql"),
    "CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT);\n",
  );
  assert.throws(
    () => migrateDatabase(path2, migDir),
    /migration 0001_bootstrap changed after being applied/,
  );
  rmSync(dir2, { recursive: true, force: true });

  const dir3 = mkdtempSync(join(tmpdir(), "iris-b1-newer-"));
  const path3 = join(dir3, "historian.db");
  const migDir3 = join(dir3, "migrations");
  mkdirSync(migDir3, { recursive: true });
  writeFileSync(
    join(migDir3, "0002_future.sql"),
    "CREATE TABLE future (id INTEGER PRIMARY KEY);\n",
  );
  migrateDatabase(path3, migDir3);
  const olderDir = join(dir3, "migrations-older");
  mkdirSync(olderDir, { recursive: true });
  writeFileSync(
    join(olderDir, "0001_bootstrap.sql"),
    "CREATE TABLE old (id INTEGER PRIMARY KEY);\n",
  );
  assert.throws(() => migrateDatabase(path3, olderDir), /database schema is NEWER than this build/);
  rmSync(dir3, { recursive: true, force: true });
});

test("B1: session state + lineage cursor round-trip", () => {
  const { store, dir } = storeFixture();
  try {
    store.upsertSessionState({
      runtimeSessionId: SESSION,
      processedThroughContextSeq: 7,
      status: "active",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(store.getSessionState(SESSION)?.processedThroughContextSeq, 7);

    store.upsertLineageCursor(STUB_LINEAGE_ID, 9, 9);
    assert.equal(store.getLineageCursor(STUB_LINEAGE_ID)?.processedThroughContextSeq, 9);
    const cursor = store.getHistorianCursor(STUB_LINEAGE_ID);
    assert.equal(cursor.processedThroughContextSeq, 9);
    assert.equal(cursor.lastCommittedCompartmentSequence, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: batch claim → commit → receipt round-trip (commit protocol state)", () => {
  const { store, dir } = storeFixture();
  try {
    const batch = makeBatch(1, 3);
    store.upsertBatchClaim(batch);
    const claimed = store.getBatch(batch.batchId);
    assert.equal(claimed?.state, "claimed");
    assert.equal(claimed?.fromContextSeq, 1);
    assert.equal(claimed?.throughContextSeq, 3);
    assert.equal(claimed?.rangeHash, "rh-1");
    assert.deepEqual(claimed?.semanticSchemaIds, ["iris.semantic.context_message.user.v1"]);

    const receipt = makeReceipt(batch.batchId, batch.claimId);
    store.markBatchCommitted(batch.batchId, receipt);
    const committed = store.getBatch(batch.batchId);
    assert.equal(committed?.state, "committed");
    assert.equal(committed?.receiptId, receipt.receiptId);
    assert.ok(committed?.receiptJson !== null, "full receipt persisted for replay");
    assert.equal(committed?.ackedAt, null, "not acked yet");

    const pendingAck = store.listCommittedBatchesNeedingAck();
    assert.equal(pendingAck.length, 1);
    const replayed = JSON.parse(pendingAck[0]?.receiptJson ?? "{}") as HistorianCommitReceiptV1;
    assert.equal(replayed.batchId, batch.batchId);
    assert.equal(replayed.rangeHash, "rh-1");

    store.markBatchAcked(batch.batchId, "2026-08-01T00:00:02.000Z");
    assert.equal(store.listCommittedBatchesNeedingAck().length, 0, "acked batch not replayed");
    assert.ok(store.getBatch(batch.batchId)?.ackedAt !== null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: store transaction begin/commit/rollback works", () => {
  const { store, dir } = storeFixture();
  try {
    store.begin();
    store.upsertSessionState({
      runtimeSessionId: SESSION,
      processedThroughContextSeq: 1,
      status: "active",
      updatedAt: "x",
    });
    store.rollback();
    assert.equal(store.getSessionState(SESSION), undefined, "rollback discards the write");
    store.begin();
    store.upsertSessionState({
      runtimeSessionId: SESSION,
      processedThroughContextSeq: 2,
      status: "active",
      updatedAt: "x",
    });
    store.commit();
    assert.equal(store.getSessionState(SESSION)?.processedThroughContextSeq, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1: unknown batch state fails closed at the DB CHECK constraint", () => {
  const { store, dir } = storeFixture();
  try {
    assert.throws(
      () => {
        store.begin();
        try {
          store
            .raw()
            .prepare(
              "INSERT INTO historian_batches (batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq, range_hash, semantic_schema_ids_json, unit_count, estimated_tokens, frozen_at, lease_expires_at, state, created_at, updated_at) VALUES ('b1','c1','l1',1,1,'h','[]',1,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z','bogus','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
            )
            .run();
          store.commit();
        } catch (error) {
          store.rollback();
          throw error;
        }
      },
      /CHECK constraint failed/,
      "DB-level CHECK rejects unknown batch state (fail closed)",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
