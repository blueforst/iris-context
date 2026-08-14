/**
 * Historian Feature B10（Phase D）—— provenance fail-closed 测试。
 *
 * 覆盖：runner 对内容漂移 / claim 锚定错误的 batch fail-closed（不推进
 * cursor、不产生 publication）、lineage 不匹配抛错。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { HistorianStore } from "../src/historian/historian-store.js";
import { HistorianRunner } from "../src/historian/historian-runner.js";
import { PublicationService } from "../src/historian/historian-publication.js";
import { historianBatchRangeHash } from "../src/contracts/historian.js";
import {
  createFixtureHistoryPort,
  STUB_LINEAGE_ID,
  simpleUnits,
} from "./helpers/historian-context-stub.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iris-b10-"));
  const store = HistorianStore.open({
    databasePath: join(dir, "historian.db"),
    nowMs: () => 1_000,
  });
  return { store, dir };
}

function batchOf(units = simpleUnits(3)) {
  const from = units[0]?.contextSeq ?? 1;
  const through = units[units.length - 1]?.contextSeq ?? from;
  const batch = {
    schemaId: "iris.historian_batch.v2" as const,
    batchId: `batch-${STUB_LINEAGE_ID}-${from}-${through}`,
    claimId: "claim-1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: "",
    semanticSchemaIds: [],
    units,
    estimatedTokens: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  batch.rangeHash = historianBatchRangeHash(batch);
  return batch;
}

function makeRunner(store: HistorianStore, units = simpleUnits(3)) {
  const historyPort = createFixtureHistoryPort({ units: () => units });
  const service = new PublicationService({ store, nowMs: () => 1_000 });
  const runner = new HistorianRunner({
    store,
    historyPort,
    commitHook: { commitBatch: (input) => service.commitBatch(input) },
  });
  return { runner, historyPort };
}

test("B10: content drift → validation_failed, cursor NOT advanced, no publication", () => {
  const { store, dir } = fixture();
  try {
    const { runner } = makeRunner(store);
    const units = simpleUnits(3);
    const batch = batchOf(units);
    // 篡改：与冻结 hash 不一致的 batch（模拟 receipt 与 frozen hash 不一致）。
    const firstUnit = units[0];
    const secondUnit = units[1];
    const thirdUnit = units[2];
    assert.ok(
      firstUnit !== undefined && secondUnit !== undefined && thirdUnit !== undefined,
      "fixture units present",
    );
    const tampered = batchOf([
      { ...firstUnit, unit: { ...firstUnit.unit, contentHash: "tampered" } },
      secondUnit,
      thirdUnit,
    ]);
    tampered.rangeHash = batch.rangeHash; // 保留冻结 hash
    const result = runner.run({ batch: tampered, runtimeSessionId: "s" });
    assert.equal(result.status, "validation_failed");
    if (result.status === "validation_failed") {
      assert.equal(result.errorCode, "source_range_hash_mismatch");
    }
    assert.equal(
      store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq,
      0,
      "cursor never advanced",
    );
    assert.equal(store.countPublications(), 0, "no publication on drift");
    assert.equal(store.countOutboxPending(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B10: claim anchor mismatch → validation_failed, cursor not advanced", () => {
  const { store, dir } = fixture();
  try {
    const { runner } = makeRunner(store);
    // 先把 cursor 推进到 3（已处理 [1..3]）。
    store.upsertLineageCursor(STUB_LINEAGE_ID, 3, 3);
    // 错误锚定：batch 从 1 开始（应 fail closed —— 不能重新 claim 已处理窗口）。
    const stale = batchOf(simpleUnits(3));
    const result = runner.run({ batch: stale, runtimeSessionId: "s" });
    assert.equal(result.status, "validation_failed");
    if (result.status === "validation_failed") {
      assert.equal(result.errorCode, "claim_anchor_mismatch");
    }
    assert.equal(
      store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq,
      3,
      "cursor unchanged",
    );
    assert.equal(store.countPublications(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B10: lineage mismatch between batch and port fails closed (throw)", () => {
  const { store, dir } = fixture();
  try {
    const historyPort = createFixtureHistoryPort({
      units: () => simpleUnits(3),
      lineageId: "other-lineage",
    });
    const service = new PublicationService({ store, nowMs: () => 1_000 });
    const runner = new HistorianRunner({
      store,
      historyPort,
      commitHook: { commitBatch: (input) => service.commitBatch(input) },
    });
    const batch = batchOf();
    assert.throws(() => runner.run({ batch }), /lineage/);
    assert.equal(store.countPublications(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B10: commit rollback on storage failure — cursor never advances", () => {
  const { store, dir } = fixture();
  try {
    const historyPort = createFixtureHistoryPort({ units: () => simpleUnits(3) });
    const runner = new HistorianRunner({
      store,
      historyPort,
      commitHook: {
        commitBatch() {
          throw new Error("simulated storage failure");
        },
      },
    });
    // 存储错误传播给调用方（requeue），事务回滚。
    let threw = false;
    try {
      runner.run({ batch: batchOf(), runtimeSessionId: "s" });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error && error.message.includes("simulated storage failure"));
    }
    assert.equal(threw, true, "storage error propagates");
    assert.equal(
      store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq,
      0,
      "cursor never advanced",
    );
    assert.equal(store.countPublications(), 0, "rollback left no publication");
    assert.equal(store.countOutboxPending(), 0, "rollback left no outbox row");
    // batch claim 也已回滚（upsertBatchClaim 在事务内）。
    assert.equal(store.listLatestBatchesByLineage(STUB_LINEAGE_ID, 5).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
