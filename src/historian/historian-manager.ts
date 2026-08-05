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
import type {
  HistorianBoundarySnapshot,
  HistorianSessionState,
  RuntimeSessionHistoryReadPort,
  SequencedSessionEntry,
} from "../contracts/historian.js";
import type { HistorianStore } from "./historian-store.js";
import { HistorianQueue, HistorianWorker, type HistorianJob } from "./historian-queue.js";
import { HistorianRunner, type RunnerCommitHook } from "./historian-runner.js";
import { freezeBoundary, type LineageBoundaryInput } from "./historian-boundary.js";
import { buildAnalysisView, validateRange } from "./historian-analysis.js";
import { PublicationService } from "./historian-publication.js";
import { runWrapup } from "./historian-continuity.js";
import { createCompactionAuthorizer, type CompactionAuthorization } from "./compaction-trigger.js";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";
/**
 * R3 Historian product integration (issue #8 Phase B Feature B8).
 *
 * One HistorianManager per Host, wiring the B1-B7 capability layers into
 * the Host lifecycle:
 *  - active incremental trigger: after every settled turn the manager
 *    freezes the current Session head and enqueues a `highest` job
 *    (pressure-critical incremental);
 *  - rollover wrapup: on rollover the OLD Session is finalized via a
 *    `normal` wrapup job — rollover does NOT wait for it;
 *  - closed Session retry: at startup the manager scans for closed /
 *    closed_incomplete Sessions with unconsumed snapshots and re-enqueues
 *    `low` retries;
 *  - publication outbox claim/delivery: a background loop claims pending
 *    rows (with lease expiry recovery) and marks delivered/failed;
 *  - shutdown: drain the queue and close the store;
 *  - health/readiness: queue + store counters.
 *
 * Boundaries: the manager NEVER reads Context m0/m1/LKG; it reads Session
 * entries only through the RuntimeSessionHistoryReadPort; it NEVER writes
 * the Pi Session; it never creates a second durable outbox.
 */

export interface HistorianManagerOptions {
  store: HistorianStore;
  /** Read port for the CURRENT active Runtime Session (Host-wired). */
  readPort: RuntimeSessionHistoryReadPort;
  /** Model/provider profile for boundary freeze. */
  modelProviderProfile: string;
  nowMs?: () => number;
  claimLeaseMs?: number;
  maxQueuedJobs?: number;
  maxAttempts?: number;
  /** R3-P4：Context lineage 物化边界读取端口（compaction 授权用）。缺省 =
   * 未接线，此时 authorizeCompaction 抛错（fail-closed）。 */
  historyPort?: ContextHistoryReadPort;
  /** Optional per-invocation recall projections for B7 assessments. */
  recallProjectionsFor?: (
    runtimeSessionId: string,
  ) => import("./historian-assessment.js").InvocationMemoryRecallProjection[];
}

export interface HistorianHealth {
  ready: boolean;
  queue: ReturnType<HistorianQueue["stats"]>;
  sessionCount: number;
  publicationCount: number;
  outboxPending: number;
}

export class HistorianManager {
  private readonly store: HistorianStore;
  private readonly readPort: RuntimeSessionHistoryReadPort;
  private readonly modelProviderProfile: string;
  private readonly nowMs: () => number;
  private readonly queue: HistorianQueue;
  private readonly worker: HistorianWorker;
  private readonly recallProjectionsFor: HistorianManagerOptions["recallProjectionsFor"];
  private readonly service: PublicationService;
  private readonly runner: HistorianRunner;
  private readonly historyPort: ContextHistoryReadPort | undefined;
  private readonly claimLeaseMs: number;
  private draining = false;

  constructor(options: HistorianManagerOptions) {
    this.store = options.store;
    this.readPort = options.readPort;
    this.modelProviderProfile = options.modelProviderProfile;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.recallProjectionsFor = options.recallProjectionsFor;
    this.historyPort = options.historyPort;
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.queue = new HistorianQueue({
      maxQueuedJobs: options.maxQueuedJobs ?? 256,
      maxAttempts: options.maxAttempts ?? 8,
      nowMs: this.nowMs,
    });
    this.service = new PublicationService({
      store: this.store,
      nowMs: this.nowMs,
      claimLeaseMs: this.claimLeaseMs,
    });
    const commitHook: RunnerCommitHook = {
      commitSafePrefix: (input) => {
        this.service.commitSafePrefix(input);
      },
    };
    this.runner = new HistorianRunner({ store: this.store, readPort: this.readPort, commitHook });
    this.worker = new HistorianWorker(this.queue, (job) => this.executeJob(job));
  }

  getStore(): HistorianStore {
    return this.store;
  }

  getService(): PublicationService {
    return this.service;
  }

  getQueue(): HistorianQueue {
    return this.queue;
  }

  /** Active incremental trigger: freeze the current Session head and
   * enqueue a highest-priority job (fire-and-forget — never blocks the Pi
   * main turn). The freeze reads the Session head through the read port. */
  async triggerIncremental(runtimeSessionId: string): Promise<boolean> {
    return this.enqueueIncremental(runtimeSessionId);
  }

  /**
   * R3-P1：lineage 感知的 active incremental trigger。冻结当前 Session head 并
   * 以 highest 优先级入队（fire-and-forget）。lineageBoundary（由
   * ContextHistoryReadPort 提供的物化边界）在 freeze 时 clamp eligible 范围：
   * 只有已进入 m0/m1 的 compartment 才可被 raw 替换（v13 m0-clamp 规格）。
   * lineageBoundary 缺省 = 纯 raw 语义（R3-P0 行为，与 triggerIncremental
   * 完全一致）。freeze-trigger 接线（vertical-slice）在 HARD fold 提交后经
   * 端口读取边界并调用本方法。
   */
  async enqueueIncremental(
    runtimeSessionId: string,
    lineageBoundary?: LineageBoundaryInput,
  ): Promise<boolean> {
    // R3-P4 B1 修复（v13 状态机不变量）：closing/closed 会话不再接收增量提交。
    // closing = wrapup 已入队（收尾中）；closed/closed_incomplete = 已终结；
    // corrupt = fail-closed（不可自动修复）。这些状态下入队增量会破坏
    // active→closing→closed 状态机（post-close 提交 / wedge 风险），拒绝并返回
    // false。只有 active 会话可以增量入队。
    const durable = this.store.getSessionState(runtimeSessionId);
    if (
      durable?.status === "closing" ||
      durable?.status === "closed" ||
      durable?.status === "closed_incomplete" ||
      durable?.status === "corrupt"
    ) {
      return false;
    }
    const frozen = await this.freezeCurrent(runtimeSessionId, lineageBoundary);
    if (frozen === null) {
      return false;
    }
    const state = durable ?? {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    return this.queue.enqueue({
      priority: "highest",
      runtimeSessionId,
      boundary: frozen.snapshot,
      sessionState: state,
    });
  }

  /** Rollover wrapup: finalize the OLD Session at `normal` priority.
   * Returns immediately — rollover does NOT wait for the wrapup job.
   *
   * R3-P4 v13 状态机：wrapup 入队即持久化 status="closing"（closing 是收尾阶段，
   * 不可再接收 incremental 提交）；wrapup 任务的最终事务把 closing → closed /
   * closed_incomplete（与 ContinuitySnapshot 同事务）。 */
  async enqueueWrapup(runtimeSessionId: string): Promise<boolean> {
    const frozen = await this.freezeCurrent(runtimeSessionId);
    if (frozen === null) {
      return false;
    }
    const durable = this.store.getSessionState(runtimeSessionId) ?? {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    const closing: HistorianSessionState = {
      ...durable,
      status: "closing",
      observedHeadEntrySeq: frozen.snapshot.observedHeadEntrySeq,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    this.store.upsertSessionState(closing);
    return this.queue.enqueue({
      priority: "normal",
      runtimeSessionId,
      boundary: frozen.snapshot,
      sessionState: closing,
    });
  }

  /** Startup recovery: re-enqueue `low` retries for closed sessions whose
   * snapshots are unconsumed, plus any retry_wait outbox rows. */
  async recover(): Promise<void> {
    const sessions = this.store.listSessions();
    for (const session of sessions) {
      if (session.status === "closed" || session.status === "closed_incomplete") {
        const frozen = await this.freezeCurrent(session.runtimeSessionId);
        if (frozen !== null && !frozen.nothingNew) {
          this.queue.enqueue({
            priority: "low",
            runtimeSessionId: session.runtimeSessionId,
            boundary: frozen.snapshot,
            sessionState: session,
          });
        }
      }
    }
  }

  /** Drain ONE job (the background pump calls this repeatedly). */
  async pumpOnce(): Promise<void> {
    await this.worker.runOnce();
  }

  /** Delivery loop: claim pending outbox rows and mark them delivered (a
   * Router port would be invoked here; for now the claim+deliver cycle is
   * exercised so lease recovery is proven). */
  drainOutbox(batchSize = 10): number {
    const batch = this.service.claimBatch({ batchSize });
    for (const row of batch) {
      this.service.markDelivered({
        publicationId: row.publicationId,
        receiptHash: `receipt-${row.outboxSequence}`,
      });
    }
    return batch.length;
  }

  /** Health/readiness snapshot. */
  health(): HistorianHealth {
    const sessionCount = this.store.countSessions();
    const publicationCount = this.store.countPublications();
    const outboxPending = this.store.countOutboxPending();
    return {
      ready: !this.draining,
      queue: this.queue.stats(),
      sessionCount,
      publicationCount,
      outboxPending,
    };
  }

  /** Recomp maintenance (manual priority). */
  async enqueueRecomp(runtimeSessionId: string): Promise<boolean> {
    const frozen = await this.freezeCurrent(runtimeSessionId);
    if (frozen === null) {
      return false;
    }
    const state = this.store.getSessionState(runtimeSessionId) ?? {
      runtimeSessionId,
      processedThroughEntrySeq: 0,
      status: "active" as const,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    return this.queue.enqueue({
      priority: "manual",
      runtimeSessionId,
      boundary: frozen.snapshot,
      sessionState: state,
    });
  }

  /** Shutdown: stop draining, drain the queue, close the store. */
  close(): void {
    this.draining = true;
    this.store.close();
  }

  /**
   * R3-P4：Pi Session compaction 授权（v13 "只有已进入 m0/m1 的 compartment 才可
   * 替换 raw P5"）。cut = min(protectedTailStartEntrySeq - 1,
   * lineageMaterializedEntrySeq)——保护尾部 raw-inviolable，任何授权都绝不越过
   * protectedTailStartEntrySeq - 1；lineage 从未物化 → cut = 0（不授权）。
   * 需要 historyPort（ContextHistoryReadPort）；未接线 → 抛错（fail-closed，
   * compaction 授权必须显式接线才能生效）。
   */
  authorizeCompaction(runtimeSessionId: string): CompactionAuthorization {
    if (this.historyPort === undefined) {
      throw new Error(
        "historian manager: authorizeCompaction requires a ContextHistoryReadPort (wire historyPort)",
      );
    }
    const authorizer = createCompactionAuthorizer({
      historyPort: this.historyPort,
      sessionReadPort: this.readPort,
      latestBoundaryFor: (sessionId) => this.store.listBoundarySnapshots(sessionId, 1)[0],
    });
    return authorizer.authorize(runtimeSessionId);
  }

  /**
   * R3-P4：在 wrapup 的最终事务内发布剩余未处理窗口（复用 B5
   * PublicationService.commitSafePrefix）。只发布 [cursor+1 ..
   * eligibleThroughEntrySeq] 的未处理 safe prefix（与 frozen sourceRangeHash
   * 同窗口）；validateRange 失败 → 本次 wrapup 只落快照（B3 语义：验证失败不
   * 推进、不发布）。recallProjectionsFor 提供的投影（若存在）在同一事务内派生
   * assessment delta。调用方必须在事务内调用本方法。
   */
  private commitWrapupPublication(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
    eligible: SequencedSessionEntry[];
    state: HistorianSessionState;
  }): void {
    const unprocessedFrom = Math.max(1, (input.state.processedThroughEntrySeq ?? 0) + 1);
    const unprocessed = input.eligible.filter((e) => e.entrySeq >= unprocessedFrom);
    if (unprocessed.length === 0) {
      return; // 全部已发布 → 仅快照，不产生新 publication
    }
    const analysis = buildAnalysisView({
      runtimeSessionId: input.runtimeSessionId,
      boundary: input.boundary,
      eligibleEntries: unprocessed,
    });
    const outcome = validateRange({
      runtimeSessionId: input.runtimeSessionId,
      boundary: input.boundary,
      eligibleEntries: unprocessed,
    });
    if (!outcome.ok) {
      return; // 边界漂移 → 本次 wrapup 只落快照（不推进、不发布）
    }
    const projections = this.recallProjectionsFor?.(input.runtimeSessionId) ?? [];
    const service =
      projections.length === 0
        ? this.service
        : new PublicationService({
            store: this.store,
            nowMs: this.nowMs,
            claimLeaseMs: this.claimLeaseMs,
            recallProjections: projections,
          });
    service.commitSafePrefix({
      runtimeSessionId: input.runtimeSessionId,
      boundary: input.boundary,
      safePrefix: unprocessed.filter((e) => e.entrySeq <= outcome.commitThroughEntrySeq),
      analysis,
      outcome,
      previousProcessedThroughEntrySeq: input.state.processedThroughEntrySeq ?? 0,
    });
  }

  // ---- internals ----

  private async freezeCurrent(
    runtimeSessionId: string,
    lineageBoundary?: LineageBoundaryInput,
  ): Promise<{ snapshot: HistorianBoundarySnapshot; nothingNew: boolean } | null> {
    const state = this.store.getSessionState(runtimeSessionId);
    const processed = state?.processedThroughEntrySeq ?? 0;
    const page = await this.readPort.readEntries({
      runtimeSessionId,
      afterEntrySeqExclusive: 0,
      limit: 4096,
    });
    if (page.entries.length === 0) {
      return null;
    }
    const result = freezeBoundary({
      rawSeamInput: {
        runtimeSessionId,
        entries: page.entries,
        processedThroughEntrySeq: processed,
        // No fixed tail margin: the freeze's arc/in-flight seam logic is the
        // protected-tail authority (a fixed margin would leave short sessions
        // permanently nothing_new). The runner's validation re-verifies the
        // seam before any commit.
        tailMarginEntries: 0,
        modelProviderProfile: this.modelProviderProfile,
        frozenAt: new Date(this.nowMs()).toISOString(),
      },
      // R3-P1 m0-clamp：lineage 物化边界（存在时）在 freeze 内收紧 eligible
      // 范围——只有已进入 m0/m1 的 compartment 才可被 raw 替换。
      ...(lineageBoundary !== undefined ? { lineageBoundary } : {}),
    });
    return { snapshot: result.snapshot, nothingNew: result.nothingNew };
  }

  private async executeJob(job: HistorianJob): Promise<{ ok: boolean; errorCode?: string }> {
    const { runtimeSessionId, boundary, priority } = job;
    try {
      if (priority === "normal" || priority === "low") {
        // Wrapup / closed retry: finalize the Session + persist snapshot.
        // The durable state may not exist yet (a fresh wrapup enqueued
        // before any incremental commit) — use the job's frozen snapshot of
        // the state in that case.
        const state = this.store.getSessionState(runtimeSessionId) ?? job.sessionState;
        if (state === undefined) {
          return { ok: false, errorCode: "session_state_missing" };
        }
        const port = this.readPort;
        const page = await port.readEntries({
          runtimeSessionId,
          afterEntrySeqExclusive: 0,
          limit: 4096,
        });
        const eligible = page.entries.filter((e) => e.entrySeq <= boundary.eligibleThroughEntrySeq);
        const analysis = buildAnalysisView({
          runtimeSessionId,
          boundary,
          eligibleEntries: eligible,
        });
        // R3-P4 v13：wrapup 的最终事务 = session_state（cursor 载体 + 状态
        // 转移）+ continuity_snapshot + 最终 publication + outbox（+
        // assessment）在 ONE 事务内原子提交（B6 review #3 原子性的规格化）。
        // runWrapup(commit:false) 只写不提交；PublicationService 在同一事务
        // 内复用 B5 的 commitSafePrefix；任何一步失败 → 整事务回滚（cursor /
        // snapshot / publication 都不落盘）。
        this.store.begin();
        try {
          runWrapup({
            store: this.store,
            runtimeSessionId,
            state,
            boundary,
            eligibleEntries: eligible,
            analysis,
            nowMs: this.nowMs,
            commit: false,
          });
          this.commitWrapupPublication({ runtimeSessionId, boundary, eligible, state });
          this.store.commit();
        } catch (error) {
          this.store.rollback();
          throw error;
        }
        return { ok: true };
      }
      // highest / manual: incremental commit via the runner.
      const result = await this.runner.run({ runtimeSessionId, boundary });
      if (result.status === "validation_failed") {
        return { ok: false, errorCode: result.errorCode ?? "validation_failed" };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, errorCode: error instanceof Error ? error.message : "unknown" };
    }
  }
}
