/**
 * Historian worker queue（Phase D）—— bounded、单 worker、全局串行。
 *
 * v27 起：无 wrapup/continuity 终结器路径 —— 队列只承载 incremental 提交
 * （highest）与手动 recomp（manual）。所有 finalizer/successor/deferred
 * 语义已删除。保留：
 *  - 任意时刻至多一个 Historian job 运行（single writer）；
 *  - enqueue() 永不阻塞调用方（fire-and-forget）；
 *  - per-lineage single-flight（同 lineage 已有 pending/running job 时不重复
 *    入队；新 job 的更新 batch 替换 pending job 的 batch）；
 *  - job identity = (priority, lineageId, runId, attempt)；
 *  - 有界队列 + 重试记账（maxAttempts + exponential backoff）；
 *    onAttemptPersist / onExhausted 持久化钩子（重试预算 durable）；
 *  - worker 永不与其他 Historian writer 并行（单 worker loop 是唯一 writer）。
 */

import type { HistorianBatchV1 } from "../contracts/historian.js";

export type HistorianJobPriority = "highest" | "manual";

export const HISTORIAN_PRIORITY_ORDER: Record<HistorianJobPriority, number> = {
  highest: 0,
  manual: 1,
};

/** 单元 of work（worker 执行）。job 携带冻结 batch（Context 坐标）。 */
export interface HistorianJob {
  priority: HistorianJobPriority;
  /** lineage-scoped 身份（Context 坐标）。 */
  lineageId: string;
  /** attribution only。 */
  runtimeSessionId: string;
  jobId: string;
  /** 0-based；bounded by maxAttempts。 */
  attempt: number;
  /** 失败后的最早可重试时刻（exponential backoff）。 */
  retryAtMs?: number;
  /** 冻结的 Context batch（worker 消费 EXACTLY 这个 batch）。 */
  batch: HistorianBatchV1;
}

export type EnqueueOutcome = "queued" | "merged" | "refused";

export interface HistorianQueueOptions {
  /** Bounded queue capacity (0 = unbounded; production default bounded). */
  maxQueuedJobs?: number;
  /** Per-job max attempts before the job is dropped (retry bound). */
  maxAttempts?: number;
  /** Clock for lease/retry timestamps. */
  nowMs?: () => number;
  /** 重试记账持久化钩子（durable attempt 计数 / exhaustion）。 */
  onAttemptPersist?: (runtimeSessionId: string, attempts: number) => void;
  onExhausted?: (job: HistorianJob) => void;
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

/** Bounded priority queue with per-lineage single-flight. */
export class HistorianQueue {
  private readonly maxQueuedJobs: number;
  private readonly maxAttempts: number;
  private readonly nowMs: () => number;
  private readonly onAttemptPersist:
    ((runtimeSessionId: string, attempts: number) => void) | undefined;
  private readonly onExhausted: ((job: HistorianJob) => void) | undefined;

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
    this.onAttemptPersist = options.onAttemptPersist;
    this.onExhausted = options.onExhausted;
  }

  /** 每-attempt 重试退避（exponential, capped）。 */
  private retryBackoffMs(attempt: number): number {
    return Math.min(2_000, 50 * 2 ** attempt);
  }

  /** True when the lineage has a pending or running job. */
  hasLineage(lineageId: string): boolean {
    return (
      this.pending.some((job) => job.lineageId === lineageId) ||
      this.running?.lineageId === lineageId
    );
  }

  /**
   * Enqueue a job。Single-flight：同 lineage 已有 pending/running job 时，
   * 新 batch 替换 pending job 的 batch（runner 每次重新 freeze；旧的 pending
   * job 已过期）。严格有界：满时丢弃最低优先级非-manual job；无法丢弃时
   * 拒绝（refused）。
   */
  enqueue(job: Omit<HistorianJob, "jobId" | "attempt" | "retryAtMs">): EnqueueOutcome {
    const existing = this.pending.find((j) => j.lineageId === job.lineageId);
    if (existing !== undefined) {
      existing.priority = job.priority;
      existing.batch = job.batch;
      existing.runtimeSessionId = job.runtimeSessionId;
      return "merged";
    }
    if (this.running?.lineageId === job.lineageId) {
      // 同 lineage 正在运行：不重复入队（runner 每次重新 freeze，更新 batch
      // 会在下一次触发中体现）。
      return "merged";
    }
    if (this.pending.length >= this.maxQueuedJobs) {
      // 严格有界：满时 evict 最低优先级的 pending job。manual（recomp 维护）
      // 永远可丢弃；highest 只在被同优先级或更高优先级的新 job 替换时丢弃。
      // 新 manual 试图 evict highest → 拒绝（维护任务宁可丢弃）。
      const candidate = this.pending
        .map((j, index) => ({ j, index }))
        .sort(
          (a, b) => HISTORIAN_PRIORITY_ORDER[b.j.priority] - HISTORIAN_PRIORITY_ORDER[a.j.priority],
        )[0];
      if (candidate !== undefined) {
        const candidatePriority = HISTORIAN_PRIORITY_ORDER[candidate.j.priority];
        const newPriority = HISTORIAN_PRIORITY_ORDER[job.priority];
        if (candidate.j.priority === "manual" || newPriority <= candidatePriority) {
          this.pending.splice(candidate.index, 1);
          this.dropped += 1;
        } else {
          return "refused";
        }
      } else {
        return "refused";
      }
    }
    const candidate: HistorianJob = {
      priority: job.priority,
      lineageId: job.lineageId,
      runtimeSessionId: job.runtimeSessionId,
      jobId: `${job.priority}:${job.lineageId}:${this.nextRunId++}`,
      attempt: 0,
      batch: job.batch,
    };
    this.pending.push(candidate);
    return "queued";
  }

  /** 最高优先级的下一个可运行 job（priority 内 FIFO；退避未过期的跳过）。 */
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

  /** Pending jobs ordered by priority then job id, filtering retry backoff. */
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
   * Retry with an incremented attempt (bounded) and exponential backoff。
   * 失败 attempt 先 durable 记账（onAttemptPersist），再做 in-memory 决策：
   * "requeued"（回到 pending + backoff）、"exhausted"（预算用尽，onExhausted
   * 持久化标记）、"no_capacity"（队列满 —— 失败被推迟而非永久；durable 计数
   * 已推进，refill/恢复不会重复 attempt N）。
   */
  requeue(job: HistorianJob): "requeued" | "exhausted" | "no_capacity" {
    const nextAttempt = job.attempt + 1;
    if (nextAttempt >= this.maxAttempts) {
      this.onExhausted?.(job);
      return "exhausted";
    }
    this.onAttemptPersist?.(job.runtimeSessionId, nextAttempt);
    if (this.pending.length >= this.maxQueuedJobs) {
      return "no_capacity";
    }
    this.pending.push({
      ...job,
      attempt: nextAttempt,
      retryAtMs: this.nowMs() + this.retryBackoffMs(nextAttempt),
    });
    return "requeued";
  }

  /** 标记当前 running job 完成。ok=true 计数成功；ok=false 永久失败；
   * undefined = requeued（回到 pending，非完成）。 */
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
 * 单 worker loop。唯一 Historian writer：一次 pull 一个 job，执行 handler，
 * 永不重叠。不阻塞调用方（调用方只 enqueue；worker loop 通过 runOnce() 运行）。
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
   * 至多执行一个 job（幂等 single-flight drain）。永不抛出：handler 失败
   * 捕获进 job result。
   */
  async runOnce(): Promise<HistorianJobResult | null> {
    if (this.runningLoop) {
      return null;
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
        if (retried === "requeued" || retried === "no_capacity") {
          this.queue.finish(undefined);
        } else {
          this.queue.finish(false);
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
