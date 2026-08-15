/**
 * compaction-trigger 直接行为测试（旧 Phase H reviewer 非阻塞项：该模块此前
 * 无直接测试）。
 *
 * authorizeCompaction / createCompactionAuthorizer 的语义（contextSeq 坐标）：
 *   cut = min(protectedTailStartContextSeq - 1, lineageMaterializedThroughContextSeq)
 *   - 无物化边界（null）→ 不授权（0）；
 *   - 保护尾部 raw-inviolable：cut 恒 ≤ protectedTailStartContextSeq - 1；
 *   - 物化 watermark 推进 → cut 推进。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeCompaction,
  createCompactionAuthorizer,
} from "../src/historian/compaction-trigger.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";

test("compaction: authorizeCompaction is bounded by protected tail and materialized watermark", () => {
  // 无物化边界 → 不授权。
  assert.equal(
    authorizeCompaction({
      protectedTailStartContextSeq: 100,
      lineageMaterializedThroughContextSeq: null,
    }),
    0,
  );
  // 常规：cut = min(tail-1, materialized)。
  assert.equal(
    authorizeCompaction({
      protectedTailStartContextSeq: 10,
      lineageMaterializedThroughContextSeq: 5,
    }),
    5,
  );
  // 保护尾部优先：materialized 越过尾部 → cut = tail-1。
  assert.equal(
    authorizeCompaction({
      protectedTailStartContextSeq: 10,
      lineageMaterializedThroughContextSeq: 99,
    }),
    9,
  );
  // 边界：tail=1 → cut=0（保护尾部绝不越过）。
  assert.equal(
    authorizeCompaction({
      protectedTailStartContextSeq: 1,
      lineageMaterializedThroughContextSeq: 5,
    }),
    0,
  );
  // materialized=0 → 0。
  assert.equal(
    authorizeCompaction({
      protectedTailStartContextSeq: 10,
      lineageMaterializedThroughContextSeq: 0,
    }),
    0,
  );
});

test("compaction: createCompactionAuthorizer resolves boundary/coverage deterministically", () => {
  // no_boundary：无保护尾部 → 不授权。
  const noBoundary = createCompactionAuthorizer("lineage-1", {
    historyPort: stubHistoryPort(7),
    latestProtectedTailStartContextSeq: () => undefined,
  });
  assert.deepEqual(noBoundary.authorize(), {
    lineageId: "lineage-1",
    cutThroughContextSeq: 0,
    reason: "no_boundary",
    protectedTailStartContextSeq: 0,
    lineageMaterializedThroughContextSeq: null,
  });

  // no_coverage：端口读物化边界失败（无 lineage）→ 不授权。
  const noCoverage = createCompactionAuthorizer("lineage-1", {
    historyPort: throwingHistoryPort(),
    latestProtectedTailStartContextSeq: () => 10,
  });
  const c1 = noCoverage.authorize();
  assert.equal(c1.cutThroughContextSeq, 0);
  assert.equal(c1.reason, "no_coverage");

  // materialized：正常授权。
  const materialized = createCompactionAuthorizer("lineage-1", {
    historyPort: stubHistoryPort(7),
    latestProtectedTailStartContextSeq: () => 10,
  });
  const c2 = materialized.authorize();
  assert.equal(c2.cutThroughContextSeq, 7);
  assert.equal(c2.reason, "materialized");
  // 保护尾部钳制。
  const tailClamped = createCompactionAuthorizer("lineage-1", {
    historyPort: stubHistoryPort(7),
    latestProtectedTailStartContextSeq: () => 5,
  });
  assert.equal(tailClamped.authorize().cutThroughContextSeq, 4, "cut never crosses the tail");
});

/** 物化 watermark=7 的 historyPort stub。 */
function stubHistoryPort(representedThroughContextSeq: number): ContextHistoryReadPort {
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq,
        representedThroughEntrySeq: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    lineageId: () => "lineage-1",
    claimHistorianBatch: () => {
      throw new Error("unused");
    },
    freezeBatch: () => {
      throw new Error("unused");
    },
  };
}

/** 读边界抛错（模拟无 lineage）的 historyPort stub。 */
function throwingHistoryPort(): ContextHistoryReadPort {
  return {
    getMaterializedBoundary() {
      throw new Error("no lineage");
    },
    lineageId: () => "lineage-1",
    claimHistorianBatch: () => {
      throw new Error("unused");
    },
    freezeBatch: () => {
      throw new Error("unused");
    },
  };
}
