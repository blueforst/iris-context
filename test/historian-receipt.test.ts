/**
 * Historian receipt + Context ACK + retirement port 测试（Phase D + E）。
 *
 * 覆盖：
 *  - HistorianCommitReceiptV1 权威形状；
 *  - ContextRetirementPortV1.acknowledgeHistorianCommit 幂等 ACK →
 *    covered units 标记 compartmentalized_pending_bust；
 *  - 未覆盖单元不受影响；越权范围不标记；
 *  - markRepresentedAndRetired 只能在 canonical BUST 原子发布事务内调用
 *    （事务外调用 fail-closed，watermark 不推进）；
 *  - reclaimRetiredPayloads 只回收 retired 单元的 payload（无 retired 单元
 *    时回收 0 行）。
 */
import test from "node:test";

import assert from "node:assert/strict";

import { ContextStore } from "../src/context/context-store.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import { createContextRetirementPort } from "../src/context/context-retirement-port.js";
import {
  newClaimId,
  newReceiptId,
  type HistorianCommitReceiptV1,
} from "../src/contracts/historian.js";
import {
  assistantInput,
  cleanupDir,
  makeLineageInput,
  tempDir,
  userInput,
} from "./helpers/context-fixtures.js";
import { join } from "node:path";

const LINEAGE = "identity-receipt";

function openContext(dir: string): { store: ContextStore; ingest: ContextIngest } {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  const ingest = new ContextIngest(store, LINEAGE);
  return { store, ingest };
}

function receipt(batchId: string, from: number, through: number): HistorianCommitReceiptV1 {
  const claimId = newClaimId();
  return {
    schemaId: "iris.historian_commit_receipt.v1",
    receiptId: newReceiptId(batchId, claimId),
    batchId,
    claimId,
    contextLineageId: LINEAGE,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: "rh-1",
    compartmentIds: [`compartment-${LINEAGE}-1`],
    publicationIds: ["publication-1"],
    outputHash: "oh-1",
    committedAt: "2026-08-01T00:00:01.000Z",
  };
}

test("receipt: ACK marks only the covered units compartmentalized_pending_bust", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = openContext(dir);
    try {
      ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a", sessionId: "session-1" }));
      ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "b", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(userInput({ eventId: "e3", content: "c", sessionId: "session-1" }));

      const port = createContextRetirementPort(store);
      port.acknowledgeHistorianCommit(receipt("batch-1", 1, 2));

      const units = ingest.listUnits("session-1");
      assert.equal(units[0]?.lifecycleState, "compartmentalized_pending_bust", "seq 1 covered");
      assert.equal(units[1]?.lifecycleState, "compartmentalized_pending_bust", "seq 2 covered");
      assert.equal(units[2]?.lifecycleState, "committed", "seq 3 outside receipt unchanged");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("receipt: ACK is idempotent — repeated ACK does not change state", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = openContext(dir);
    try {
      ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a", sessionId: "session-1" }));
      const port = createContextRetirementPort(store);
      port.acknowledgeHistorianCommit(receipt("batch-1", 1, 1));
      port.acknowledgeHistorianCommit(receipt("batch-1", 1, 1));
      port.acknowledgeHistorianCommit(receipt("batch-1", 1, 1));
      const units = ingest.listUnits("session-1");
      assert.equal(units[0]?.lifecycleState, "compartmentalized_pending_bust");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("receipt: ACK never advances represented/retired watermarks (only Phase E BUST may)", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = openContext(dir);
    try {
      ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a", sessionId: "session-1" }));
      const port = createContextRetirementPort(store);
      port.acknowledgeHistorianCommit(receipt("batch-1", 1, 1));
      const lineage = store.getLineageByLineageId(LINEAGE);
      assert.equal(
        lineage?.representedThroughContextSeq,
        0,
        "represented watermark untouched by ACK",
      );
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("receipt: Phase E retirement requires the BUST atomic publish transaction", () => {
  const dir = tempDir();
  try {
    const { store, ingest } = openContext(dir);
    try {
      ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a", sessionId: "session-1" }));
      const port = createContextRetirementPort(store);
      // 事务外调用 markRepresentedAndRetired → fail-closed（绝不允许绕过 BUST
      // 的逻辑退休），watermark 不推进。
      assert.throws(() => {
        port.markRepresentedAndRetired({
          contextLineageId: LINEAGE,
          contextGenerationId: "gen-outside",
          contextGenerationHash: "hash-outside",
          representedThroughContextSeq: 1,
          retiredThroughContextSeq: 1,
        });
      }, /BUST atomic publish transaction|markRepresentedAndRetired/);
      const lineage = store.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 0, "watermark untouched");
      assert.equal(lineage?.retiredThroughContextSeq, 0, "retired watermark untouched");
      assert.equal(lineage?.lastBustGenerationId, null, "no generation binding outside BUST");
      // 单元保持原状态（未推进 retirement）。
      assert.equal(ingest.listUnits("session-1")[0]?.lifecycleState, "committed");
      // reclaim 只回收 retired 单元：无 retired 单元 → 0 行。
      const gc = port.reclaimRetiredPayloads({ maxRows: 100, maxBytes: 1_000_000 });
      assert.equal(gc.reclaimedRows, 0);
      assert.equal(gc.reclaimedBytes, 0);
      assert.equal(ingest.listUnits("session-1")[0]?.lifecycleState, "committed");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("receipt: receipt identity is deterministic per (batch, claim)", () => {
  const r1 = receipt("batch-1", 1, 2);
  assert.equal(r1.schemaId, "iris.historian_commit_receipt.v1");
  assert.equal(r1.receiptId, newReceiptId("batch-1", r1.claimId));
  assert.equal(r1.fromContextSeq, 1);
  assert.equal(r1.throughContextSeq, 2);
  assert.deepEqual(r1.compartmentIds, [`compartment-${LINEAGE}-1`]);
  assert.deepEqual(r1.publicationIds, ["publication-1"]);
});
