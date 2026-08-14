/**
 * Historian Feature B11（Phase D）—— durable retry-budget 测试。
 *
 * 覆盖：失败 attempt 的 durable 记账（onAttemptPersist → session retry
 * columns）、retry-exhausted 持久化标记、explicit reactivation、health 计数。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { HistorianStore } from "../src/historian/historian-store.js";
import { HistorianQueue, type HistorianJob } from "../src/historian/historian-queue.js";
import { STUB_LINEAGE_ID, simpleUnits } from "./helpers/historian-context-stub.js";
import type { HistorianBatchV2 } from "../src/contracts/historian.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iris-b11-"));
  const store = HistorianStore.open({
    databasePath: join(dir, "historian.db"),
    nowMs: () => 1_000,
  });
  return { store, dir };
}

function fakeJob(overrides?: Partial<HistorianJob>): HistorianJob {
  const batch: HistorianBatchV2 = {
    schemaId: "iris.historian_batch.v2",
    batchId: "batch-1",
    claimId: "c1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 2,
    rangeHash: "rh",
    semanticSchemaIds: [],
    units: simpleUnits(2),
    estimatedTokens: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
  return {
    priority: "highest",
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-retry",
    jobId: "job-1",
    attempt: 0,
    batch,
    ...overrides,
  };
}

test("B11: failed attempts are persisted durably and only ever advance", () => {
  const { store, dir } = fixture();
  try {
    // 预置 session state（retry accounting 载体）。
    store.upsertSessionState({
      runtimeSessionId: "session-retry",
      status: "active",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    let now = 1_000;
    const queue = new HistorianQueue({
      maxQueuedJobs: 4,
      maxAttempts: 5,
      nowMs: () => now,
      onAttemptPersist: (session, attempts) => {
        store.recordRetryAttempt(session, attempts);
      },
      onExhausted: (job) => {
        store.markRetryExhausted(job.runtimeSessionId);
      },
    });
    queue.enqueue({
      priority: "highest",
      lineageId: STUB_LINEAGE_ID,
      runtimeSessionId: "session-retry",
      batch: fakeJob().batch,
    });
    const j1 = queue.take();
    assert.ok(j1, "job taken");
    assert.equal(queue.requeue(j1), "requeued");
    assert.equal(
      store.getSessionState("session-retry")?.retryAttempts,
      1,
      "attempt durably persisted",
    );
    now = 10_000;
    const j2 = queue.take();
    assert.ok(j2, "job taken");
    assert.equal(queue.requeue(j2), "requeued");
    assert.equal(store.getSessionState("session-retry")?.retryAttempts, 2);
    assert.equal(store.countExhaustedSessions(), 0, "not exhausted yet");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B11: exhaustion is durable; reactivation resets and re-admits", () => {
  const { store, dir } = fixture();
  try {
    store.upsertSessionState({
      runtimeSessionId: "session-retry",
      status: "active",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    let now = 1_000;
    const queue = new HistorianQueue({
      maxQueuedJobs: 4,
      maxAttempts: 2,
      nowMs: () => now,
      onAttemptPersist: (session, attempts) => {
        store.recordRetryAttempt(session, attempts);
      },
      onExhausted: (job) => {
        store.markRetryExhausted(job.runtimeSessionId);
      },
    });
    queue.enqueue({
      priority: "highest",
      lineageId: STUB_LINEAGE_ID,
      runtimeSessionId: "session-retry",
      batch: fakeJob().batch,
    });
    const j1 = queue.take();
    assert.ok(j1, "job taken");
    assert.equal(queue.requeue(j1), "requeued"); // attempt 0 → 1
    now = 10_000;
    const j2 = queue.take();
    assert.ok(j2, "job taken");
    assert.equal(queue.requeue(j2), "exhausted"); // attempt 1 → exhausted (maxAttempts=2)
    const state = store.getSessionState("session-retry");
    assert.equal(state?.retryExhaustedAt !== undefined, true, "exhaustion marker persisted");
    assert.equal(store.countExhaustedSessions(), 1);
    // 已 exhausted 的 session 不允许无 reactivation 地恢复 retry 预算。
    assert.equal(
      store.getSessionState("session-retry")?.retryAttempts,
      1,
      "the single completed failed attempt is durable after exhaustion",
    );
    // Explicit reactivation 重置预算。
    assert.equal(store.reactivateExhaustedSession("session-retry"), true);
    const reset = store.getSessionState("session-retry");
    assert.equal(reset?.retryExhaustedAt, undefined, "marker cleared");
    assert.equal(reset?.retryAttempts, undefined, "attempt counter reset");
    assert.equal(store.countExhaustedSessions(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B11: exhausted marker survives restart (reopen reads durable state)", () => {
  const { store, dir } = fixture();
  const path = join(dir, "historian.db");
  try {
    store.upsertSessionState({
      runtimeSessionId: "session-retry",
      status: "active",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    store.markRetryExhausted("session-retry");
    store.close();
    const reopened = HistorianStore.reopen(path, undefined, () => 2_000);
    const state = reopened.getSessionState("session-retry");
    assert.equal(state?.retryExhaustedAt !== undefined, true, "exhaustion durable across reopen");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
