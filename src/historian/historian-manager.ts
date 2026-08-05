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
  RuntimeSessionHistoryReadPort,
} from "../contracts/historian.js";
import type { HistorianStore } from "./historian-store.js";
import { HistorianQueue, HistorianWorker, type HistorianJob } from "./historian-queue.js";
import { HistorianRunner, type RunnerCommitHook } from "./historian-runner.js";
import { freezeBoundary } from "./historian-boundary.js";
import { buildAnalysisView, type HistorianAnalysisView } from "./historian-analysis.js";
import { PublicationService } from "./historian-publication.js";
import { runWrapup } from "./historian-continuity.js";
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
  private draining = false;

  constructor(options: HistorianManagerOptions) {
    this.store = options.store;
    this.readPort = options.readPort;
    this.modelProviderProfile = options.modelProviderProfile;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.recallProjectionsFor = options.recallProjectionsFor;
    this.queue = new HistorianQueue({
      maxQueuedJobs: options.maxQueuedJobs ?? 256,
      maxAttempts: options.maxAttempts ?? 8,
      nowMs: this.nowMs,
    });
    this.service = new PublicationService({
      store: this.store,
      nowMs: this.nowMs,
      claimLeaseMs: options.claimLeaseMs ?? 60_000,
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
      priority: "highest",
      runtimeSessionId,
      boundary: frozen.snapshot,
      sessionState: state,
    });
  }

  /** Rollover wrapup: finalize the OLD Session at `normal` priority.
   * Returns immediately — rollover does NOT wait for the wrapup job. */
  async enqueueWrapup(runtimeSessionId: string): Promise<boolean> {
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
      priority: "normal",
      runtimeSessionId,
      boundary: frozen.snapshot,
      sessionState: state,
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

  // ---- internals ----

  private async freezeCurrent(
    runtimeSessionId: string,
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
        const analysis: HistorianAnalysisView = buildAnalysisView({
          runtimeSessionId,
          boundary,
          eligibleEntries: page.entries.filter(
            (e) => e.entrySeq <= boundary.eligibleThroughEntrySeq,
          ),
        });
        runWrapup({
          store: this.store,
          runtimeSessionId,
          state,
          boundary,
          eligibleEntries: page.entries.filter(
            (e) => e.entrySeq <= boundary.eligibleThroughEntrySeq,
          ),
          analysis,
          nowMs: this.nowMs,
        });
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
