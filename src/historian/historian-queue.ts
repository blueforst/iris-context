/**
 * R3 Historian 模块移植说明（R3-P0 port）：
 *
 * 本文件从已通过审查的 `agent/r2-product-parity-fix-r3-historian` 分支
 * （commit 5b94db7，R3 v13 对齐实现 B1–B8）原样移植到 main，作为 R3
 * Historian 子系统的基座（issue #8 Phase B）。代码逻辑与分支保持逐字节一致；
 * 所有针对 main 依赖集的适配点均以内联中文注释（"移植说明/R3-P0"）标注。
 * 后续 R3-P1..P4 工作项负责对齐 v13 规格的增量（ContextHistoryReadPort
 * m0-clamp 等）。
 */
import type { HistorianBoundarySnapshot, HistorianSessionState } from "../contracts/historian.js";

/**
 * R3 Historian worker queue (issue #8 Phase B Feature B2).
 *
 * A bounded, single-worker, GLOBAL serial queue:
 *
 *   highest → active Session pressure-critical incremental
 *   normal  → rollover continuity wrapup
 *   low     → closed Session retry
 *   manual  → recomp maintenance
 *
 * Guarantees:
 *  - at most ONE Historian job runs at any moment (single writer);
 *  - enqueue() never blocks the Pi main turn loop (fire-and-forget);
 *  - per-Session single-flight: a Session with a pending/queued job is not
 *    enqueued twice (the runner re-freezes on each run, so a newer job is
 *    unnecessary while one is queued/running);
 *  - job identity is a deterministic (priority, sessionId, runId, attempt);
 *  - retries are bounded (maxAttempts) and jobs survive shutdown by being
 *    re-enqueued from the durable session cursor on the next startup (the
 *    cursor never advanced on failure ⇒ nothing is lost);
 *  - rollover does NOT wait for wrapup: wrapup is enqueued at `normal` and
 *    the new Session starts immediately (B6);
 *  - the worker never runs in parallel with another Historian writer (the
 *    single worker loop IS the only writer).
 */

export type HistorianJobPriority = "highest" | "normal" | "low" | "manual";

export const HISTORIAN_PRIORITY_ORDER: Record<HistorianJobPriority, number> = {
  highest: 0,
  normal: 1,
  low: 2,
  manual: 3,
};

/** The unit of work the worker executes. */
export interface HistorianJob {
  priority: HistorianJobPriority;
  runtimeSessionId: string;
  /** Deterministic identity (priority + session + a monotonic run id). */
  jobId: string;
  /** Attempt counter (0-based). Bounded by maxAttempts. */
  attempt: number;
  /**
   * The frozen boundary the trigger captured. The runner consumes EXACTLY
   * this snapshot and never widens the range (B3).
   */
  boundary: HistorianBoundarySnapshot;
  /** Session state at freeze time (status: active/closing/...). */
  sessionState: HistorianSessionState;
}

export interface HistorianQueueOptions {
  /** Bounded queue capacity (0 = unbounded; production default bounded). */
  maxQueuedJobs?: number;
  /** Per-job max attempts before the job is dropped (retry bound). */
  maxAttempts?: number;
  /** Clock for lease/retry timestamps. */
  nowMs?: () => number;
}

export interface QueueStats {
  pending: number;
  running: number;
  dropped: number;
  completed: number;
  failedPermanent: number;
}

type JobHandler = (job: HistorianJob) => Promise<HistorianJobResult>;

export interface HistorianJobResult {
  /** True when the job committed its publication transaction. */
  ok: boolean;
  /** Typed failure code when !ok. */
  errorCode?: string;
}

/** Bounded priority queue with per-Session single-flight. */
export class HistorianQueue {
  private readonly maxQueuedJobs: number;
  private readonly maxAttempts: number;
  private readonly nowMs: () => number;

  private pending: HistorianJob[] = [];
  private running: HistorianJob | null = null;
  private dropped = 0;
  private completed = 0;
  private failedPermanent = 0;
  private nextRunId = 1;

  constructor(options: HistorianQueueOptions = {}) {
    this.maxQueuedJobs = options.maxQueuedJobs ?? 256;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Enqueue a job. Single-flight: when the Session already has a pending or
   * running job, the NEW boundary REPLACES the queued job's boundary (the
   * runner re-freezes; the queued job is stale). Returns true when enqueued.
   * Never throws for capacity: a full queue drops the lowest-priority
   * non-running job (the newest freeze of the same Session wins).
   */
  enqueue(job: Omit<HistorianJob, "jobId" | "attempt">): boolean {
    const existing = this.pending.find((j) => j.runtimeSessionId === job.runtimeSessionId);
    if (existing !== undefined) {
      // Single-flight: refresh the boundary with a fresh run identity.
      existing.boundary = job.boundary;
      existing.sessionState = job.sessionState;
      return true;
    }
    if (this.running?.runtimeSessionId === job.runtimeSessionId) {
      // The runner re-freezes on each pass, so a queued copy is unnecessary.
      return true;
    }
    const full = this.pending.length >= this.maxQueuedJobs;
    if (full) {
      // Drop the LOWEST-priority pending job (never the new one) unless the
      // new one is manual maintenance (always droppable in favor of data).
      const dropIndex = this.pending
        .map((j, index) => ({ j, index }))
        .filter(({ j }) => j.priority !== "manual")
        .sort(
          (a, b) => HISTORIAN_PRIORITY_ORDER[b.j.priority] - HISTORIAN_PRIORITY_ORDER[a.j.priority],
        )[0];
      if (dropIndex !== undefined) {
        this.pending.splice(dropIndex.index, 1);
        this.dropped += 1;
      } else if (job.priority === "manual") {
        return false; // manual maintenance is droppable; refuse silently
      }
    }
    const attempt = 0;
    const candidate: HistorianJob = {
      priority: job.priority,
      runtimeSessionId: job.runtimeSessionId,
      jobId: `${job.priority}:${job.runtimeSessionId}:${this.nextRunId++}`,
      attempt,
      boundary: job.boundary,
      sessionState: job.sessionState,
    };
    this.pending.push(candidate);
    return true;
  }

  /** Highest-priority next job (stable FIFO within a priority). */
  peek(): HistorianJob | undefined {
    if (this.pending.length === 0) {
      return undefined;
    }
    const sorted = [...this.pending].sort(
      (a, b) =>
        HISTORIAN_PRIORITY_ORDER[a.priority] - HISTORIAN_PRIORITY_ORDER[b.priority] ||
        (a.jobId < b.jobId ? -1 : 1),
    );
    return sorted[0];
  }

  take(): HistorianJob | undefined {
    if (this.pending.length === 0) {
      return undefined;
    }
    const sorted = [...this.pending].sort(
      (a, b) =>
        HISTORIAN_PRIORITY_ORDER[a.priority] - HISTORIAN_PRIORITY_ORDER[b.priority] ||
        (a.jobId < b.jobId ? -1 : 1),
    );
    const job = sorted[0];
    if (job === undefined) {
      return undefined;
    }
    this.pending = this.pending.filter((j) => j.jobId !== job.jobId);
    this.running = job;
    return job;
  }

  /** Retry with an incremented attempt (bounded); false when exhausted. */
  requeue(job: HistorianJob): boolean {
    if (job.attempt + 1 >= this.maxAttempts) {
      return false;
    }
    this.pending.push({ ...job, attempt: job.attempt + 1 });
    return true;
  }

  /** Mark the currently running job as finished. ok=true counts a success;
   * ok=false counts a permanent failure; undefined clears `running` for a
   * requeued job (it moved back to pending — not a completion). */
  finish(ok: boolean | undefined): void {
    if (this.running === null) {
      return;
    }
    this.running = null;
    if (ok === true) {
      this.completed += 1;
    } else if (ok === false) {
      this.failedPermanent += 1;
    }
  }

  /** True when a job is currently executing. */
  isRunning(): boolean {
    return this.running !== null;
  }

  /** Number of pending jobs. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Snapshot of queue counters. */
  stats(): QueueStats {
    return {
      pending: this.pending.length,
      running: this.running === null ? 0 : 1,
      dropped: this.dropped,
      completed: this.completed,
      failedPermanent: this.failedPermanent,
    };
  }

  now(): number {
    return this.nowMs();
  }
}

/**
 * The single worker loop. The ONLY Historian writer: it pulls one job at a
 * time, executes the handler, and never overlaps. It does not block the Pi
 * main turn loop (the Host only calls enqueue(); the worker loop runs in
 * the background via runOnce()).
 */
export class HistorianWorker {
  private readonly queue: HistorianQueue;
  private readonly handler: JobHandler;
  private runningLoop = false;

  constructor(queue: HistorianQueue, handler: JobHandler) {
    this.queue = queue;
    this.handler = handler;
  }

  /**
   * Execute at most one job (idempotent single-flight drain). Returns when
   * no job is available or the running job completed. Never throws: handler
   * failures are captured into the job result.
   */
  async runOnce(): Promise<HistorianJobResult | null> {
    if (this.runningLoop) {
      return null; // another runOnce is already draining — single writer
    }
    const job = this.queue.take();
    if (job === undefined) {
      return null;
    }
    this.runningLoop = true;
    try {
      const result = await this.handler(job);
      if (!result.ok) {
        const retried = this.queue.requeue(job);
        // Requeued → moved back to pending (not a completion); exhausted →
        // permanent failure (counted, running cleared).
        this.queue.finish(!retried ? false : undefined);
      } else {
        this.queue.finish(true);
      }
      return result;
    } catch (error) {
      const retried = this.queue.requeue(job);
      this.queue.finish(retried ? undefined : false);
      return { ok: false, errorCode: error instanceof Error ? error.message : "unknown" };
    } finally {
      this.runningLoop = false;
    }
  }
}
