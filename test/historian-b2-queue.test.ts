/**
 * Historian Feature B2（Phase D）—— bounded single-worker queue 测试。
 *
 * 覆盖：single-flight（per-lineage）、优先级、有界容量 eviction、重试记账
 * （backoff / attempt / exhaustion / no_capacity）、worker runOnce 单写者。
 * v27 起无 finalizer/successor/deferred 语义。
 */
import test from "node:test";

import assert from "node:assert/strict";

import {
  HistorianQueue,
  HistorianWorker,
  type HistorianJob,
} from "../src/historian/historian-queue.js";
import type { HistorianBatchV2 } from "../src/contracts/historian.js";
import { STUB_LINEAGE_ID, simpleUnits } from "./helpers/historian-context-stub.js";

function fakeBatch(from = 1, through = 2): HistorianBatchV2 {
  return {
    schemaId: "iris.historian_batch.v2",
    batchId: `batch-${STUB_LINEAGE_ID}-${from}-${through}`,
    claimId: "claim-1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: "rh",
    semanticSchemaIds: [],
    units: simpleUnits(through),
    estimatedTokens: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
}

test("B2: enqueue → take → finish lifecycle; single-flight per lineage", () => {
  const queue = new HistorianQueue({ nowMs: () => 1_000 });
  assert.equal(
    queue.enqueue({
      priority: "highest",
      lineageId: "l1",
      runtimeSessionId: "s",
      batch: fakeBatch(),
    }),
    "queued",
  );
  // Single-flight: same lineage merge.
  assert.equal(
    queue.enqueue({
      priority: "highest",
      lineageId: "l1",
      runtimeSessionId: "s",
      batch: fakeBatch(1, 4),
    }),
    "merged",
  );
  assert.equal(queue.pendingCount(), 1);
  const taken = queue.take();
  assert.equal(taken?.lineageId, "l1");
  assert.equal(taken?.batch.throughContextSeq, 4, "merged job carries the newest batch");
  queue.finish(true);
  assert.equal(queue.stats().completed, 1);
  assert.equal(queue.isRunning(), false);
});

test("B2: priority ordering — highest before manual", () => {
  const queue = new HistorianQueue({ nowMs: () => 1_000 });
  queue.enqueue({ priority: "manual", lineageId: "l2", runtimeSessionId: "s", batch: fakeBatch() });
  queue.enqueue({
    priority: "highest",
    lineageId: "l1",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  assert.equal(queue.take()?.lineageId, "l1", "highest runs first");
  assert.equal(queue.take()?.lineageId, "l2");
});

test("B2: bounded queue — evicts lowest-priority pending; refuses manual over highest", () => {
  const queue = new HistorianQueue({ maxQueuedJobs: 2, nowMs: () => 1_000 });
  assert.equal(
    queue.enqueue({
      priority: "highest",
      lineageId: "l1",
      runtimeSessionId: "s",
      batch: fakeBatch(),
    }),
    "queued",
  );
  assert.equal(
    queue.enqueue({
      priority: "manual",
      lineageId: "l2",
      runtimeSessionId: "s",
      batch: fakeBatch(),
    }),
    "queued",
  );
  // 满 + 全为 highest → 新 manual 被拒绝（维护任务宁可丢弃）。
  const allHighest = new HistorianQueue({ maxQueuedJobs: 2, nowMs: () => 1_000 });
  allHighest.enqueue({
    priority: "highest",
    lineageId: "l1",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  allHighest.enqueue({
    priority: "highest",
    lineageId: "l2",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  assert.equal(
    allHighest.enqueue({
      priority: "manual",
      lineageId: "l3",
      runtimeSessionId: "s",
      batch: fakeBatch(),
    }),
    "refused",
    "manual cannot evict highest",
  );
  // 满且存在 manual pending → 新 highest evict 最低优先级 manual。
  assert.equal(
    queue.enqueue({
      priority: "highest",
      lineageId: "l3",
      runtimeSessionId: "s",
      batch: fakeBatch(),
    }),
    "queued",
  );
  assert.equal(queue.stats().dropped, 1);
  assert.equal(queue.pendingCount(), 2);
  const taken1 = queue.take();
  const taken2 = queue.take();
  assert.deepEqual(
    [taken1?.lineageId, taken2?.lineageId].sort(),
    ["l1", "l3"],
    "manual l2 evicted, highest l1+l3 remain",
  );
});

test("B2: retry accounting — backoff gate, attempt bound, durable hooks", () => {
  const nowMs = { value: 1_000 };
  const queue = new HistorianQueue({ maxQueuedJobs: 4, maxAttempts: 3, nowMs: () => nowMs.value });
  const attempts: Array<[string, number]> = [];
  const exhausted: string[] = [];
  const queue2 = new HistorianQueue({
    maxQueuedJobs: 4,
    maxAttempts: 3,
    nowMs: () => nowMs.value,
    onAttemptPersist: (session, attempt) => attempts.push([session, attempt]),
    onExhausted: (j) => exhausted.push(j.jobId),
  });
  void queue;
  queue2.enqueue({
    priority: "highest",
    lineageId: "l1",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  const j1 = queue2.take();
  assert.ok(j1);
  // First failure → requeued with backoff; attempt durably persisted.
  assert.equal(queue2.requeue(j1), "requeued");
  assert.deepEqual(attempts, [["s", 1]]);
  // Backoff gate: not runnable until the retry window elapses.
  assert.equal(queue2.peek(), undefined, "backoff not elapsed → not runnable");
  nowMs.value = 10_000;
  const j2 = queue2.take();
  assert.equal(j2?.attempt, 1);
  // Second failure → attempt 2.
  assert.equal(queue2.requeue(j2 as HistorianJob), "requeued");
  nowMs.value = 20_000;
  const j3 = queue2.take();
  assert.equal(j3?.attempt, 2);
  // Third failure → exhausted (maxAttempts=3, attempts 0,1,2 used).
  assert.equal(queue2.requeue(j3 as HistorianJob), "exhausted");
  assert.equal(exhausted.length, 1, "exhaustion hook fired");
  assert.equal(queue2.stats().failedPermanent, 0, "exhaustion is not a finish; worker handles it");
});

test("B2: worker runOnce executes at most one job (single writer)", async () => {
  const queue = new HistorianQueue({ nowMs: () => 1_000 });
  queue.enqueue({
    priority: "highest",
    lineageId: "l1",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  queue.enqueue({
    priority: "highest",
    lineageId: "l2",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  let calls = 0;
  const worker = new HistorianWorker(queue, async () => {
    calls += 1;
    return { ok: true };
  });
  const result = await worker.runOnce();
  assert.ok(result);
  assert.equal(calls, 1, "runOnce executes exactly one job");
  assert.equal(queue.stats().completed, 1);
  const result2 = await worker.runOnce();
  assert.ok(result2);
  assert.equal(calls, 2);
  assert.equal(await worker.runOnce(), null, "empty queue → null");
});

test("B2: worker captures handler failure into the job result (never throws)", async () => {
  const queue = new HistorianQueue({ maxAttempts: 2, nowMs: () => 1_000 });
  queue.enqueue({
    priority: "highest",
    lineageId: "l1",
    runtimeSessionId: "s",
    batch: fakeBatch(),
  });
  const worker = new HistorianWorker(queue, async () => {
    throw new Error("boom");
  });
  const result = await worker.runOnce();
  assert.equal(result?.ok, false);
  assert.ok(result?.errorCode?.includes("boom"));
});
