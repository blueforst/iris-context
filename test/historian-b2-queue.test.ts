/**
 * R3-P0 移植说明：本测试从已验证的 `agent/r2-product-parity-fix-r3-historian`
 * 分支（commit 5b94db7）原样移植，覆盖 Feature B2（单进程全局队列：4 级优先级、
 * 单飞行、有界容量、有限重试）。
 */
import test from "node:test";

import assert from "node:assert/strict";

import {
  HistorianQueue,
  HistorianWorker,
  type HistorianJob,
} from "../src/historian/historian-queue.js";
import type {
  HistorianBoundarySnapshot,
  HistorianSessionState,
} from "../src/contracts/historian.js";

/**
 * Feature B2 — single-process global Historian worker queue.
 */

const SESSION_A = "iris-runtime-2026-08-01-1";
const SESSION_B = "iris-runtime-2026-08-02-1";
const SESSION_C = "iris-runtime-2026-08-03-1";

function snapshot(session: string, head = 10): HistorianBoundarySnapshot {
  return {
    boundarySnapshotId: `bs-${session}-${head}`,
    runtimeSessionId: session,
    lineageId: "identity-b2",
    observedHeadEntrySeq: head,
    observedHeadContextSeq: head,
    eligibleThroughEntrySeq: head - 3,
    eligibleThroughContextSeq: head - 3,
    protectedTailStartEntrySeq: head - 2,
    trueRawEligibleTokens: 100,
    narratableEligibleTokens: 80,
    sourceRangeHash: `hash-${session}-${head}`,
    modelProviderProfile: "opencode/deepseek-v4-flash",
    frozenAt: "2026-08-01T00:00:00.000Z",
  };
}

function state(session: string): HistorianSessionState {
  return {
    runtimeSessionId: session,
    processedThroughEntrySeq: 0,
    status: "active",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("B2: queue is single-flight per Session — a newer freeze replaces the queued boundary", () => {
  const queue = new HistorianQueue();
  assert.equal(
    queue.enqueue({
      priority: "normal",
      runtimeSessionId: SESSION_A,
      boundary: snapshot(SESSION_A, 10),
      sessionState: state(SESSION_A),
    }),
    "queued",
  );
  // Same Session re-freeze: no new job, boundary refreshed.
  assert.equal(
    queue.enqueue({
      priority: "normal",
      runtimeSessionId: SESSION_A,
      boundary: snapshot(SESSION_A, 20),
      sessionState: state(SESSION_A),
    }),
    "merged",
  );
  assert.equal(queue.pendingCount(), 1, "single-flight keeps one queued job");
  const peeked = queue.peek();
  assert.equal(
    peeked?.boundary.observedHeadEntrySeq,
    20,
    "boundary refreshed to the newest freeze",
  );
  // A running job also suppresses a queued copy.
  const taken = queue.take();
  assert.ok(taken);
  assert.equal(
    queue.enqueue({
      priority: "normal",
      runtimeSessionId: SESSION_A,
      boundary: snapshot(SESSION_A, 30),
      sessionState: state(SESSION_A),
    }),
    "merged",
  );
  assert.equal(queue.pendingCount(), 0, "no queued copy while running");
  assert.equal(
    queue.successorCount(),
    0,
    "running NORMAL (finalizing) job absorbs the duplicate request — no successor",
  );
  queue.finish(true);
});

test("B2: priority order — highest > normal > low > manual, FIFO within priority", () => {
  const queue = new HistorianQueue();
  queue.enqueue({
    priority: "low",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 1),
    sessionState: state(SESSION_A),
  });
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B, 1),
    sessionState: state(SESSION_B),
  });
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_C,
    boundary: snapshot(SESSION_C, 1),
    sessionState: state(SESSION_C),
  });
  assert.equal(queue.take()?.priority, "highest");
  assert.equal(queue.take()?.priority, "normal");
  assert.equal(queue.take()?.priority, "low");
  assert.equal(queue.take(), undefined);
  queue.finish(true);
  // manual is lowest (fresh sessions to avoid single-flight suppression).
  queue.enqueue({
    priority: "manual",
    runtimeSessionId: SESSION_C,
    boundary: snapshot(SESSION_C, 2),
    sessionState: state(SESSION_C),
  });
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B, 2),
    sessionState: state(SESSION_B),
  });
  assert.equal(queue.take()?.priority, "normal");
  assert.equal(queue.take()?.priority, "manual");
  queue.finish(true);
});

test("B2: bounded queue drops the lowest-priority NON-finalizing pending job, never the new one", () => {
  const queue = new HistorianQueue({ maxQueuedJobs: 2 });
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 1),
    sessionState: state(SESSION_A),
  });
  queue.enqueue({
    priority: "manual",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B, 1),
    sessionState: state(SESSION_B),
  });
  // Third job exceeds capacity → the MANUAL (lowest-priority non-finalizing)
  // pending job is dropped. Finalizing jobs (normal/low) are never evictable.
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_C,
    boundary: snapshot(SESSION_C, 1),
    sessionState: state(SESSION_C),
  });
  assert.equal(queue.pendingCount(), 2);
  assert.equal(queue.stats().dropped, 1, "one job dropped for capacity");
  const first = queue.take();
  assert.notEqual(first?.runtimeSessionId, SESSION_B, "SESSION_B (manual) was dropped");
  queue.finish(true);
});

test("B2: retry is bounded by maxAttempts; exhausted jobs fail permanently", () => {
  const queue = new HistorianQueue({ maxAttempts: 3 });
  const job: HistorianJob = {
    priority: "normal",
    runtimeSessionId: SESSION_A,
    jobId: "j-1",
    attempt: 0,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  };
  assert.equal(queue.requeue(job), "requeued", "attempt 0 → 1");
  assert.equal(queue.requeue({ ...job, attempt: 1 }), "requeued", "attempt 1 → 2");
  assert.equal(
    queue.requeue({ ...job, attempt: 2 }),
    "exhausted",
    "attempt 2 ≥ max → permanent fail",
  );
  assert.equal(
    queue.stats().failedPermanent,
    0,
    "permanent fail counted by finish(false), not requeue",
  );
});

test("B2: worker runs at most ONE job at a time (single writer)", async () => {
  const queue = new HistorianQueue();
  const executionLog: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const handler = async (job: HistorianJob) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    executionLog.push(`${job.runtimeSessionId}:${job.priority}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    concurrent -= 1;
    return { ok: true };
  };
  const worker = new HistorianWorker(queue, handler);
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  });
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B),
    sessionState: state(SESSION_B),
  });
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_C,
    boundary: snapshot(SESSION_C),
    sessionState: state(SESSION_C),
  });
  // Drain: runOnce until empty.
  let guard = 0;
  while (queue.pendingCount() > 0 && guard++ < 10) {
    await worker.runOnce();
  }
  assert.equal(maxConcurrent, 1, "never more than one concurrent job");
  assert.equal(executionLog.length, 3);
  assert.equal(executionLog[0]?.split(":")[1], "highest", "highest runs first");
  assert.equal(queue.stats().completed, 3);
});

test("B2: worker requeues on failure (retry with backoff) and finishes on permanent failure", async () => {
  // iris_agent#53: requeue applies exponential backoff (retryAtMs), so the
  // test drives a fake clock past the backoff window between runOnce passes.
  let fakeNow = 0;
  const queue = new HistorianQueue({ maxAttempts: 3, nowMs: () => fakeNow });
  let attempts = 0;
  const handler = async (job: HistorianJob) => {
    void job;
    attempts += 1;
    if (attempts < 3) {
      return { ok: false, errorCode: "transient" };
    }
    return { ok: true };
  };
  const worker = new HistorianWorker(queue, handler);
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  });
  let guard = 0;
  while (queue.pendingCount() > 0 && guard++ < 10) {
    // Advance the clock past the retry backoff so the requeued job is
    // runnable again (iris_agent#53).
    fakeNow += 2_000;
    await worker.runOnce();
  }
  assert.equal(attempts, 3, "retried twice, succeeded on the third");
  assert.equal(queue.stats().completed, 1, "only the successful attempt counts as completed");
  assert.equal(queue.stats().failedPermanent, 0);
});

test("B2: runOnce is idempotent single-flight — concurrent calls do not double-execute", async () => {
  const queue = new HistorianQueue();
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async () => {
    executions += 1;
    await gate;
    return { ok: true };
  };
  const worker = new HistorianWorker(queue, handler);
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  });
  const first = worker.runOnce();
  // Immediately call again while the first is mid-flight.
  const second = worker.runOnce();
  release?.();
  await Promise.all([first, second]);
  assert.equal(executions, 1, "the second runOnce returned null (single-flight)");
  assert.equal(queue.stats().completed, 1);
});

test("B2: job identity is deterministic (priority:session:runId)", () => {
  const queue = new HistorianQueue();
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  });
  queue.enqueue({
    priority: "low",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B),
    sessionState: state(SESSION_B),
  });
  const a = queue.take();
  const b = queue.take();
  assert.ok(a?.jobId.startsWith("normal:iris-runtime-2026-08-01-1:"));
  assert.ok(b?.jobId.startsWith("low:iris-runtime-2026-08-02-1:"));
  queue.finish(true);
});

// F5 (iris_agent#42): a running NON-finalizing job must never suppress a
// finalizing request — the terminal transition must run after current work.
test("F5: wrapup while a highest job runs registers exactly one successor promoted after finish", () => {
  const queue = new HistorianQueue();
  // Start a highest incremental for Session A.
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 10),
    sessionState: state(SESSION_A),
  });
  const running = queue.take();
  assert.equal(running?.priority, "highest");

  // Wrapup arrives while the incremental is running.
  const closing: HistorianSessionState = { ...state(SESSION_A), status: "closing" };
  assert.equal(
    queue.enqueue({
      priority: "normal",
      runtimeSessionId: SESSION_A,
      boundary: snapshot(SESSION_A, 20),
      sessionState: closing,
    }),
    "successor_registered",
  );
  // Not in pending (single-flight) but registered as successor.
  assert.equal(queue.pendingCount(), 0);
  assert.equal(queue.successorCount(), 1);

  // The incremental completes; the successor is promoted to pending.
  queue.finish(true);
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.successorCount(), 0);
  const promoted = queue.take();
  assert.equal(promoted?.priority, "normal", "successor keeps its finalizing priority");
  assert.equal(
    promoted?.boundary.observedHeadEntrySeq,
    20,
    "successor carries the newest boundary",
  );
  assert.equal(promoted?.sessionState.status, "closing");
  queue.finish(true);
});

test("a finalizing request while a FINALIZING job runs is a duplicate (no second successor)", () => {
  const queue = new HistorianQueue();
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 10),
    sessionState: { ...state(SESSION_A), status: "closing" },
  });
  queue.take();
  // Duplicate wrapup while the finalizer runs: must NOT register a
  // successor (AC6 — no duplicate ContinuitySnapshot / transition).
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 10),
    sessionState: { ...state(SESSION_A), status: "closing" },
  });
  assert.equal(queue.successorCount(), 0);
  queue.finish(true);
  assert.equal(queue.pendingCount(), 0, "no duplicate finalizer after the running one completes");
});

test("requeue keeps the successor registered until the retry chain truly finishes", () => {
  // iris_agent#53: requeue applies backoff (retryAtMs); drive a fake clock.
  let fakeNow = 0;
  const queue = new HistorianQueue({ nowMs: () => fakeNow });
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 10),
    sessionState: state(SESSION_A),
  });
  const job = queue.take();
  assert.ok(job !== undefined);
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 20),
    sessionState: { ...state(SESSION_A), status: "closing" },
  });
  // Failure → worker requeues the job (back to pending) and finishes with
  // undefined: the successor must stay registered (not promoted, not lost).
  queue.requeue(job);
  queue.finish(undefined);
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.successorCount(), 1, "successor survives a retry");
  // Retry completes → successor promoted.
  fakeNow += 2_000; // past the retry backoff window
  const retry = queue.take();
  assert.ok(retry !== undefined);
  queue.finish(true);
  assert.equal(queue.successorCount(), 0);
  assert.equal(queue.pendingCount(), 1);
  const promoted = queue.take();
  assert.equal(promoted?.priority, "normal", "the finalizer runs after the retry chain finishes");
});

test("non-finalizing requests while running are still suppressed (no successor)", () => {
  const queue = new HistorianQueue();
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 10),
    sessionState: state(SESSION_A),
  });
  queue.take();
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 20),
    sessionState: state(SESSION_A),
  });
  assert.equal(queue.successorCount(), 0, "fresher incremental is redundant (runner re-freezes)");
  queue.finish(true);
  assert.equal(queue.pendingCount(), 0);
});

test("F5: successor and pending-merge paths coexist for different sessions", () => {
  const queue = new HistorianQueue();
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  });
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B),
    sessionState: state(SESSION_B),
  });
  queue.take(); // A running
  // A: wrapup while running → registered successor.
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 20),
    sessionState: { ...state(SESSION_A), status: "closing" },
  });
  // B: wrapup while a highest job is PENDING → merged into pending with the
  // finalizing priority winning (B1 merge rule), not a successor.
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B, 20),
    sessionState: { ...state(SESSION_B), status: "closing" },
  });
  assert.equal(queue.successorCount(), 1, "only the running-session wrapup is a successor");
  assert.equal(queue.pendingCount(), 1, "B's wrapup merged with its pending highest job");

  // A completes → A's successor promoted; B's merged finalizer still pending.
  queue.finish(true);
  assert.equal(queue.successorCount(), 0);
  assert.equal(queue.pendingCount(), 2);
  // Both pending jobs are finalizing (normal) — execution order between the
  // two sessions is deterministic by jobId but not architecturally relevant;
  // what matters is that BOTH run as finalizers and neither is lost.
  const first = queue.take();
  assert.equal(first?.priority, "normal", "first pending job is a finalizer");
  queue.finish(true);
  const second = queue.take();
  assert.equal(second?.priority, "normal", "second pending job is a finalizer");
  queue.finish(true);
  assert.equal(queue.pendingCount(), 0);
  assert.equal(queue.successorCount(), 0);
});

test("F5: capacity pressure never evicts a finalizing job or a promoted successor", () => {
  const queue = new HistorianQueue({ maxQueuedJobs: 2 });
  // Session A: running highest + wrapup successor registered.
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A),
    sessionState: state(SESSION_A),
  });
  const runningA = queue.take();
  assert.ok(runningA !== undefined);
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 20),
    sessionState: { ...state(SESSION_A), status: "closing" },
  });
  // Session B + C: fill the pending bound with highest jobs.
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_B,
    boundary: snapshot(SESSION_B),
    sessionState: state(SESSION_B),
  });
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_C,
    boundary: snapshot(SESSION_C),
    sessionState: state(SESSION_C),
  });
  assert.equal(queue.pendingCount(), 2, "pending at capacity");

  // A finishes → successor promoted. Capacity is full: the LOWEST-priority
  // NON-finalizing job (a highest) is evicted, never the finalizer.
  queue.finish(true);
  assert.equal(queue.pendingCount(), 2, "bound respected");
  // Drain everything: the finalizer must still be present and runnable.
  const drained: HistorianJob[] = [];
  let job = queue.take();
  while (job !== undefined) {
    drained.push(job);
    queue.finish(true);
    job = queue.take();
  }
  assert.equal(drained.length, 2);
  assert.ok(
    drained.some((j) => j.priority === "normal" && j.runtimeSessionId === SESSION_A),
    "promoted finalizer survives capacity pressure",
  );
  assert.ok(
    !drained.some((j) => j.runtimeSessionId === SESSION_B),
    "a highest job was evicted instead",
  );
  assert.equal(queue.successorCount(), 0);

  // Second scenario: while the finalizer sits in pending, further capacity
  // pressure must never evict it (only non-finalizing jobs are evictable).
  queue.enqueue({
    priority: "highest",
    runtimeSessionId: SESSION_A,
    boundary: snapshot(SESSION_A, 10),
    sessionState: state(SESSION_A),
  });
  queue.enqueue({
    priority: "normal",
    runtimeSessionId: SESSION_C,
    boundary: snapshot(SESSION_C, 20),
    sessionState: { ...state(SESSION_C), status: "closing" },
  });
  const top = queue.peek();
  assert.ok(top !== undefined, "queue still holds work");
  assert.equal(queue.pendingCount(), 2, "bound respected");
  queue.finish(true);
});
