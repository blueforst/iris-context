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

/** Finalizing priorities: wrapup (normal) and recovery (low) both run the
 * terminal closing → closed / closed_incomplete transition. They must never
 * be suppressed by a running non-finalizing job (F5, iris_agent#42). */
export function isFinalizing(priority: HistorianJobPriority): boolean {
  return priority === "normal" || priority === "low";
}

/** The unit of work the worker executes. */
export interface HistorianJob {
  priority: HistorianJobPriority;
  runtimeSessionId: string;
  /** Deterministic identity (priority + session + a monotonic run id). */
  jobId: string;
  /** Attempt counter (0-based). Bounded by maxAttempts. */
  attempt: number;
  /**
   * iris_agent#53: earliest epoch-ms at which this job may run again after a
   * failed attempt (exponential backoff, capped). peek/take skip jobs whose
   * retryAtMs is in the future, so a failing job cannot hot-loop.
   */
  retryAtMs?: number;
  /**
   * The frozen boundary the trigger captured. The runner consumes EXACTLY
   * this snapshot and never widens the range (B3).
   */
  boundary: HistorianBoundarySnapshot;
  /** Session state at freeze time (status: active/closing/...). */
  sessionState: HistorianSessionState;
}

/**
 * iris_agent#53: typed enqueue/scheduling outcome. The scheduler is STRICTLY
 * bounded — a full queue never grows memory, never drops a finalizer, and
 * never blocks the caller:
 * - "queued": admitted to pending;
 * - "merged": the Session already had a pending/running job; the newer
 *   boundary superseded it (single-flight);
 * - "successor_registered": recorded as the terminal successor of a running
 *   non-finalizing job (exactly one per Session, newest boundary wins);
 * - "deferred_durable": a finalization intent could NOT be admitted (queue
 *   full of finalizers / successor slots exhausted) — it is NOT lost: the
 *   durable closing intent remains in the store and the deterministic
 *   backlog refill re-admits it when capacity frees;
 * - "refused": non-finalizing maintenance dropped under capacity pressure
 *   (droppable by design, never silently claimed as queued).
 */
export type EnqueueOutcome =
  "queued" | "merged" | "successor_registered" | "deferred_durable" | "refused";

export interface HistorianQueueOptions {
  /** Bounded queue capacity (0 = unbounded; production default bounded). */
  maxQueuedJobs?: number;
  /**
   * iris_agent#53: explicit bound on the per-Session terminal-successor
   * registry (defaults to maxQueuedJobs). The successors map is memory too:
   * it gets its own documented capacity model.
   */
  maxSuccessors?: number;
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
  /** F5 (iris_agent#42): registered terminal successors awaiting a running job. */
  successors: number;
  /** iris_agent#53: finalization intents deferred to the durable backlog. */
  deferred: number;
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
  private readonly maxSuccessors: number;
  private readonly maxAttempts: number;
  private readonly nowMs: () => number;

  private pending: HistorianJob[] = [];
  private running: HistorianJob | null = null;
  /**
   * F5 (iris_agent#42): per-Session terminal-successor slot. When a
   * FINALIZING request (normal wrapup / low recovery) arrives while the same
   * Session has a NON-finalizing job running, the queue must not suppress it:
   * the runner re-freezes on each pass, so a fresher incremental is
   * redundant, but a finalization transition (closing → closed /
   * closed_incomplete with its ContinuitySnapshot) is NOT — it must run after
   * the current work. At most one successor per Session is retained (the
   * newest boundary wins); it is promoted to pending when the running job
   * finishes.
   */
  private successors = new Map<string, HistorianJob>();
  private dropped = 0;
  private completed = 0;
  private failedPermanent = 0;
  /** iris_agent#53: finalization intents deferred to the durable backlog. */
  private deferred = 0;
  private nextRunId = 1;

  constructor(options: HistorianQueueOptions = {}) {
    this.maxQueuedJobs = options.maxQueuedJobs ?? 256;
    this.maxSuccessors = options.maxSuccessors ?? this.maxQueuedJobs;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /** iris_agent#53: per-attempt retry backoff (exponential, capped). */
  private retryBackoffMs(attempt: number): number {
    return Math.min(2_000, 50 * 2 ** attempt);
  }

  /** True when the Session has a pending, running or successor job. */
  hasSession(runtimeSessionId: string): boolean {
    return (
      this.pending.some((j) => j.runtimeSessionId === runtimeSessionId) ||
      this.running?.runtimeSessionId === runtimeSessionId ||
      this.successors.has(runtimeSessionId)
    );
  }

  /**
   * Enqueue a job. Single-flight: when the Session already has a pending or
   * running job, the NEW boundary REPLACES the queued job's boundary (the
   * runner re-freezes; the queued job is stale).
   *
   * iris_agent#53: STRICTLY bounded. A full queue NEVER grows memory and
   * NEVER drops a finalization intent: when no non-finalizing job can be
   * evicted, a finalizing job is NOT admitted (deferred_durable) — its
   * durable closing intent stays in the store and the deterministic backlog
   * refill re-admits it when capacity frees.
   */
  enqueue(job: Omit<HistorianJob, "jobId" | "attempt" | "retryAtMs">): EnqueueOutcome {
    const existing = this.pending.find((j) => j.runtimeSessionId === job.runtimeSessionId);
    if (existing !== undefined) {
      // Single-flight: refresh the boundary with a fresh run identity.
      // B1 复审修复（终结性任务胜出）：merge 的优先级必须保证终结性任务
      // （normal=wrapup / low=恢复，跑 wrapup 路径 closing→closed）在并发
      // 交错下胜出——无论它是已有任务还是新任务。若直接 `existing.priority =
      // job.priority`，并发 wrapup + incremental 时（incremental 的守卫读取
      // 早于 wrapup 持久化 closing、其 enqueue 晚于 wrapup 入队），增量会把
      // pending wrapup 升级为 highest → worker 走 runner 路径提交 cursor、
      // wrapup 任务丢失 → 会话卡死 closing（recover 只恢复 closed/closed_
      // incomplete）且无 ContinuitySnapshot 的 wedge 复发。
      if (isFinalizing(existing.priority) || isFinalizing(job.priority)) {
        // 任一是终结性任务 → 合并结果必须是终结性任务（取已有的，否则取新的）。
        existing.priority = isFinalizing(existing.priority) ? existing.priority : job.priority;
      } else {
        // 两者均非终结性（highest/manual，都走 runner 路径）→ 采用新优先级。
        existing.priority = job.priority;
      }
      existing.boundary = job.boundary;
      existing.sessionState = job.sessionState;
      return "merged";
    }
    if (this.running?.runtimeSessionId === job.runtimeSessionId) {
      // F5 (iris_agent#42): a running NON-finalizing job must not suppress a
      // finalizing request. The runner re-freezes on each pass, so a queued
      // copy of a fresher incremental is unnecessary — but a terminal
      // transition (wrapup/recovery) is required work: retain exactly one
      // finalizing successor (newest boundary wins) and run it after the
      // current job finishes. When the RUNNING job is itself finalizing, the
      // new finalizing request is a duplicate (the running finalizer is the
      // terminal transition) and must NOT register a successor — otherwise a
      // repeated wrapup would run the terminal transition twice and produce
      // a duplicate ContinuitySnapshot (iris_agent#42 AC6).
      if (isFinalizing(job.priority) && !isFinalizing(this.running.priority)) {
        if (this.successors.size >= this.maxSuccessors) {
          // iris_agent#53: the successor registry has its own bound; a
          // finalization intent beyond it stays durable (deferred) — the
          // refill re-admits it, so nothing is lost and memory is bounded.
          this.deferred += 1;
          return "deferred_durable";
        }
        this.successors.set(job.runtimeSessionId, {
          priority: job.priority,
          runtimeSessionId: job.runtimeSessionId,
          jobId: `${job.priority}:${job.runtimeSessionId}:${this.nextRunId++}`,
          attempt: 0,
          boundary: job.boundary,
          sessionState: job.sessionState,
        });
        return "successor_registered";
      }
      // Either a duplicate finalizer while a finalizer runs (the running job
      // IS the terminal transition) or a redundant non-finalizing request:
      // nothing to register — single-flight "merged" semantics.
      return "merged";
    }
    const full = this.pending.length >= this.maxQueuedJobs;
    if (full) {
      // Drop the LOWEST-priority pending job (never the new one, and NEVER a
      // finalizing job) unless the new one is manual maintenance (always
      // droppable in favor of data). F5 (iris_agent#42 AC g): a terminal
      // finalizer (normal wrapup / low recovery) must never be evicted by
      // capacity pressure — the durable closing transition would be lost.
      const dropIndex = this.pending
        .map((j, index) => ({ j, index }))
        .filter(({ j }) => j.priority !== "manual" && !isFinalizing(j.priority))
        .sort(
          (a, b) => HISTORIAN_PRIORITY_ORDER[b.j.priority] - HISTORIAN_PRIORITY_ORDER[a.j.priority],
        )[0];
      if (dropIndex !== undefined) {
        this.pending.splice(dropIndex.index, 1);
        this.dropped += 1;
      } else if (job.priority === "manual") {
        return "refused"; // manual maintenance is droppable; refuse silently
      } else {
        // iris_agent#53: no non-finalizing candidate to evict — the queue is
        // full of finalization work. DO NOT admit (memory must stay bounded):
        // a finalization intent is deferred to the durable backlog, where it
        // already lives as the closing session state; the refill re-admits it.
        this.deferred += 1;
        return "deferred_durable";
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
    return "queued";
  }

  /** Highest-priority next RUNNABLE job (stable FIFO within a priority;
   * jobs whose retry backoff has not elapsed are skipped — iris_agent#53). */
  peek(): HistorianJob | undefined {
    const now = this.nowMs();
    return this.sortedRunnable(now)[0];
  }

  take(): HistorianJob | undefined {
    const now = this.nowMs();
    const sorted = this.sortedRunnable(now);
    const job = sorted[0];
    if (job === undefined) {
      return undefined;
    }
    this.pending = this.pending.filter((j) => j.jobId !== job.jobId);
    this.running = job;
    return job;
  }

  /** Pending jobs ordered by priority, then job id, filtering retry backoff. */
  private sortedRunnable(now: number): HistorianJob[] {
    return [...this.pending]
      .filter((j) => j.retryAtMs === undefined || j.retryAtMs <= now)
      .sort(
        (a, b) =>
          HISTORIAN_PRIORITY_ORDER[a.priority] - HISTORIAN_PRIORITY_ORDER[b.priority] ||
          (a.jobId < b.jobId ? -1 : 1),
      );
  }

  /**
   * Retry with an incremented attempt (bounded) and exponential backoff.
   * iris_agent#53: three outcomes — "requeued" (moved back to pending with
   * backoff), "exhausted" (attempts used up: permanent failure), or
   * "no_capacity" (the queue is full: the job is NOT lost — its durable
   * closing intent remains in the store and the deterministic backlog
   * refill re-admits it; the failure is deferred, not permanent).
   */
  requeue(job: HistorianJob): "requeued" | "exhausted" | "no_capacity" {
    if (job.attempt + 1 >= this.maxAttempts) {
      return "exhausted";
    }
    if (this.pending.length >= this.maxQueuedJobs) {
      this.deferred += 1;
      return "no_capacity";
    }
    this.pending.push({
      ...job,
      attempt: job.attempt + 1,
      retryAtMs: this.nowMs() + this.retryBackoffMs(job.attempt + 1),
    });
    return "requeued";
  }

  /**
   * Mark the currently running job as finished. ok=true counts a success;
   * ok=false counts a permanent failure; undefined clears `running` for a
   * requeued job (it moved back to pending — not a completion).
   *
   * F5 (iris_agent#42): after the running job truly completes (ok true or
   * false), a registered terminal successor for the same Session is promoted
   * to pending so the finalizer (closing → closed / closed_incomplete) is
   * guaranteed to run exactly once more. A successor is only registered when
   * the running job is non-finalizing (a finalizing job IS the terminal
   * transition). On requeue (ok === undefined) the job moved back to pending
   * and is not a completion, so the successor stays registered until the
   * retry chain truly finishes.
   */
  finish(ok: boolean | undefined): void {
    const finished = this.running;
    if (finished === null) {
      return;
    }
    this.running = null;
    if (ok === true) {
      this.completed += 1;
    } else if (ok === false) {
      this.failedPermanent += 1;
    }
    if (ok !== undefined) {
      const successor = this.successors.get(finished.runtimeSessionId);
      if (successor !== undefined) {
        this.successors.delete(finished.runtimeSessionId);
        // F5 (iris_agent#42 AC g): promotion must never overflow the bound at
        // the cost of the finalizer — evict the lowest-priority NON-finalizing
        // pending job when full instead of dropping or overflowing the
        // successor.
        if (this.pending.length >= this.maxQueuedJobs) {
          const evictIndex = this.pending
            .map((j, index) => ({ j, index }))
            .filter(({ j }) => !isFinalizing(j.priority))
            .sort(
              (a, b) =>
                HISTORIAN_PRIORITY_ORDER[b.j.priority] - HISTORIAN_PRIORITY_ORDER[a.j.priority],
            )[0];
          if (evictIndex !== undefined) {
            this.pending.splice(evictIndex.index, 1);
            this.dropped += 1;
          } else {
            // iris_agent#53: pending is ALL finalization work and full — do
            // NOT grow memory. The successor's session is still 'closing' in
            // the store; the deterministic durable-backlog refill re-admits
            // it when capacity frees (a re-freeze yields the same terminal
            // transition; exactly-once is preserved by the idempotent
            // closing → closed/closed_incomplete commit).
            this.deferred += 1;
            return;
          }
        }
        this.pending.push(successor);
      }
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
      successors: this.successors.size,
      deferred: this.deferred,
    };
  }

  /** F5 (iris_agent#42): number of registered terminal successors. */
  successorCount(): number {
    return this.successors.size;
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
        if (retried === "requeued") {
          // Requeued → moved back to pending (not a completion).
          this.queue.finish(undefined);
        } else if (retried === "exhausted") {
          // Attempts used up → permanent failure (counted, running cleared).
          this.queue.finish(false);
        } else {
          // no_capacity: the queue is full — the durable closing intent
          // remains and the backlog refill re-admits it; NOT a permanent
          // failure (deferred, not counted).
          this.queue.finish(undefined);
        }
      } else {
        this.queue.finish(true);
      }
      return result;
    } catch (error) {
      const retried = this.queue.requeue(job);
      if (retried === "requeued" || retried === "no_capacity") {
        this.queue.finish(undefined);
      } else {
        this.queue.finish(false);
      }
      return { ok: false, errorCode: error instanceof Error ? error.message : "unknown" };
    } finally {
      this.runningLoop = false;
    }
  }
}
