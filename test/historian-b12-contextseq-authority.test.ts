/**
 * Historian Feature B12（Phase D）—— contextSeq authority 测试。
 *
 * 覆盖：cursor 是 lineage-scoped 的 Context 坐标（processedThroughContextSeq）；
 * 批锚定严格从 cursor+1 开始；多次提交单调推进；batch membership 由
 * lineage + 全局 contextSeq 决定（runtimeSessionId 只作 attribution）。
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
  fixtureUnit,
} from "./helpers/historian-context-stub.js";

function units(count: number) {
  const out = [];
  for (let seq = 1; seq <= count; seq += 1) {
    out.push(
      fixtureUnit({
        contextSeq: seq,
        kind: seq % 2 === 1 ? "user" : "assistant",
        semanticSchemaId:
          seq % 2 === 1
            ? "iris.semantic.context_message.user.v1"
            : "iris.semantic.context_message.assistant.v1",
        semanticContent: { role: seq % 2 === 1 ? "user" : "assistant", content: `m${seq}` },
      }),
    );
  }
  return out;
}

function batchOf(unitsToUse: ReturnType<typeof units>, lineageId = STUB_LINEAGE_ID) {
  const from = unitsToUse[0]?.contextSeq ?? 1;
  const through = unitsToUse[unitsToUse.length - 1]?.contextSeq ?? from;
  const batch = {
    schemaId: "iris.historian_batch.v2" as const,
    batchId: `batch-${lineageId}-${from}-${through}`,
    claimId: "claim-1",
    contextLineageId: lineageId,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: "",
    semanticSchemaIds: [],
    units: unitsToUse,
    estimatedTokens: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  batch.rangeHash = historianBatchRangeHash(batch);
  return batch;
}

test("B12: batch membership and cursor are lineage + global contextSeq (not session)", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-"));
  try {
    const store = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      // 两个 lineage 使用同一批 contextSeq 号，但 cursor 相互独立。
      const unitsA = units(2);
      const unitsB = units(2).map((u) => ({ ...u, contextLineageId: "lineage-B" }));
      const portA = createFixtureHistoryPort({ units: () => unitsA, lineageId: STUB_LINEAGE_ID });
      const portB = createFixtureHistoryPort({ units: () => unitsB, lineageId: "lineage-B" });
      const service = new PublicationService({ store, nowMs: () => 1_000 });
      const runnerA = new HistorianRunner({
        store,
        historyPort: portA,
        commitHook: { commitBatch: (input) => service.commitBatch(input) },
      });
      const runnerB = new HistorianRunner({
        store,
        historyPort: portB,
        commitHook: { commitBatch: (input) => service.commitBatch(input) },
      });

      const resultA = runnerA.run({
        batch: batchOf(unitsA, STUB_LINEAGE_ID),
        runtimeSessionId: "session-A",
      });
      assert.equal(resultA.status, "committed");
      const resultB = runnerB.run({
        batch: batchOf(unitsB, "lineage-B"),
        runtimeSessionId: "session-B",
      });
      assert.equal(resultB.status, "committed");

      assert.equal(store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq, 2);
      assert.equal(store.getHistorianCursor("lineage-B").processedThroughContextSeq, 2);
      assert.equal(store.countPublications(), 2, "one publication per lineage");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B12: monotonic cursor advance across sequential batches on one lineage", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b12-seq-"));
  try {
    const store = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      const all = units(6);
      // 第一次只处理 [1..3]。
      const port = createFixtureHistoryPort({ units: () => all });
      const service = new PublicationService({ store, nowMs: () => 1_000 });
      const runner = new HistorianRunner({
        store,
        historyPort: port,
        commitHook: { commitBatch: (input) => service.commitBatch(input) },
      });
      const first = runner.run({ batch: batchOf(all.slice(0, 3)), runtimeSessionId: "s" });
      assert.equal(first.status, "committed");
      assert.equal(store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq, 3);

      // 第二批 [4..6]：批锚定 = cursor+1 = 4。
      const second = runner.run({ batch: batchOf(all.slice(3)), runtimeSessionId: "s" });
      assert.equal(second.status, "committed");
      assert.equal(store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq, 6);
      // 重复旧批（cursor 已到 6，批从 4 开始）→ claim anchor mismatch。
      const stale = runner.run({ batch: batchOf(all.slice(3)), runtimeSessionId: "s" });
      assert.equal(stale.status, "validation_failed");
      assert.equal(
        store.getHistorianCursor(STUB_LINEAGE_ID).processedThroughContextSeq,
        6,
        "cursor never rewinds",
      );
      assert.equal(store.countPublications(), 2, "exactly two publications");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
