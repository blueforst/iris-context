/**
 * HistorianManager（Phase D）—— Historian 产品集成。
 *
 * 接线 B1-B7 能力层：
 *  - active incremental trigger：freeze（Context freezeBatch）+ enqueue highest；
 *  - 单 worker pump：runOnce → runner（原子 commit + receipt）；
 *  - commit 后通过 ContextRetirementPortV1.acknowledgeHistorianCommit 幂等 ACK
 *    （把 covered units 标记 compartmentalized_pending_bust）；
 *  - startup recovery：重放未 ACK 的 committed receipt（不重复生成
 *    Publication）+ 未处理 batch 重新 freeze + 未投递 outbox 重新投递；
 *  - publication outbox claim/delivery：claim pending rows（lease 过期回收），
 *    只有验证过绑定身份的 Memory receipt 才标记 delivered；
 *  - health/readiness：queue + store 计数器。
 *
 * v27 起无 wrapup/continuity 终结器路径。边界：manager 绝不读取 Context
 * repository 内部，绝不写 Pi Session；只通过 ContextHistoryReadPort +
 * ContextRetirementPortV1 窄端口交互。
 */

import type { ContextHistoryReadPort } from "../context/history-read-port.js";
import type { ContextRetirementPortV1 } from "../contracts/context-retirement.js";
import type { HistorianStore } from "./historian-store.js";
import { HistorianQueue, HistorianWorker, type HistorianJob } from "./historian-queue.js";
import { HistorianRunner, type RunnerCommitHook } from "./historian-runner.js";
import {
  PublicationService,
  type MemoryDeliveryReceipt,
  type OutboxRow,
} from "./historian-publication.js";
import type { HistorianSemanticAdapterRegistry } from "./semantic-adapter-registry.js";
import { createCompactionAuthorizer, type CompactionAuthorization } from "./compaction-trigger.js";

const MAX_FREEZE_HEAD_CONTEXT_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * 已知可接受的 Memory Service contract 版本（绑定 receipt 校验）。
 * 当前消费 `iris-memory-contracts@0.3.0`（pin b55b5e1c…，producer
 * blueforst/iris_memory）。新增可接受版本必须显式加入（fail-closed）。
 */
const KNOWN_MEMORY_CONTRACT_VERSIONS: readonly string[] = ["0.3.0"];

/** Memory Service 投递端口（provider-neutral；由 Memory Service Adapter 实现）。 */
export interface MemoryDeliveryClientPort {
  deliverPublication(
    payload: unknown,
  ): Promise<
    | { ok: true; receipt: MemoryDeliveryReceipt }
    | { ok: false; error: "rejected" | "unavailable" | "http_5xx"; detail?: string }
  >;
}

export interface HistorianManagerOptions {
  store: HistorianStore;
  /** Context-owned history read/claim port —— 唯一正常语义输入。 */
  historyPort: ContextHistoryReadPort;
  /** Context retirement / ACK port（commit 后幂等 ACK）。 */
  retirementPort: ContextRetirementPortV1;
  /** semantic adapter 注册表（frozen processing profile；可选）。 */
  registry?: HistorianSemanticAdapterRegistry;
  nowMs?: () => number;
  claimLeaseMs?: number;
  maxQueuedJobs?: number;
  maxAttempts?: number;
  /** freeze 批量有界化提示。 */
  maxUnits?: number;
  maxTokens?: number;
  /** Memory Service 投递器（缺省 = 未接线：outbox 永不标记 delivered）。 */
  memoryClient?: MemoryDeliveryClientPort;
}

export interface HistorianHealth {
  ready: boolean;
  queue: ReturnType<HistorianQueue["stats"]>;
  sessionCount: number;
  publicationCount: number;
  outboxPending: number;
  retryExhausted: number;
  /** HistorianCursor（processedThroughContextSeq / lastCommittedCompartmentSequence）。 */
  cursor: { processedThroughContextSeq: number; lastCommittedCompartmentSequence: number };
  memoryDelivery: "configured" | "unavailable";
  deliveryErrors: number;
  lastDeliveryError: string | undefined;
}

export class HistorianManager {
  private readonly store: HistorianStore;
  private readonly historyPort: ContextHistoryReadPort;
  private readonly retirementPort: ContextRetirementPortV1;
  private readonly registry: HistorianSemanticAdapterRegistry | undefined;
  private readonly nowMs: () => number;
  private readonly queue: HistorianQueue;
  private readonly worker: HistorianWorker;
  private readonly service: PublicationService;
  private readonly runner: HistorianRunner;
  private readonly memoryClient: MemoryDeliveryClientPort | undefined;
  private readonly claimLeaseMs: number;
  private readonly maxQueuedJobs: number;
  private readonly maxUnits: number | undefined;
  private readonly maxTokens: number | undefined;
  private draining = false;
  private deliveryErrors = 0;
  private lastDeliveryError: string | undefined;

  constructor(options: HistorianManagerOptions) {
    this.store = options.store;
    if (options.historyPort === undefined) {
      throw new Error(
        "historian manager: ContextHistoryReadPort is required (Historian's normal semantic input must be Context-owned committed units)",
      );
    }
    if (options.retirementPort === undefined) {
      throw new Error(
        "historian manager: ContextRetirementPortV1 is required (commit protocol needs idempotent Context ACK)",
      );
    }
    this.historyPort = options.historyPort;
    this.retirementPort = options.retirementPort;
    this.registry = options.registry;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.memoryClient = options.memoryClient;
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.maxQueuedJobs = options.maxQueuedJobs ?? 256;
    this.maxUnits = options.maxUnits;
    this.maxTokens = options.maxTokens;
    this.queue = new HistorianQueue({
      maxQueuedJobs: this.maxQueuedJobs,
      maxAttempts: options.maxAttempts ?? 8,
      nowMs: this.nowMs,
      // durable retry accounting（重试预算跨重启持久）。
      onAttemptPersist: (runtimeSessionId, attempts) => {
        this.store.recordRetryAttempt(runtimeSessionId, attempts);
      },
      onExhausted: (job) => {
        this.store.markRetryExhausted(job.runtimeSessionId);
      },
    });
    this.service = new PublicationService({
      store: this.store,
      nowMs: this.nowMs,
      claimLeaseMs: this.claimLeaseMs,
      ...(this.registry !== undefined ? { registry: this.registry } : {}),
    });
    const commitHook: RunnerCommitHook = {
      commitBatch: (input) => this.service.commitBatch(input),
    };
    this.runner = new HistorianRunner({
      store: this.store,
      historyPort: this.historyPort,
      ...(this.registry !== undefined ? { registry: this.registry } : {}),
      commitHook,
    });
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

  /**
   * Active incremental trigger（lineage-scoped）：freeze（Context
   * freezeBatch）+ enqueue highest（fire-and-forget）。closing/closed 状态
   * 的终结器已删除 —— lineage 无限期 active，增量提交持续由
   * processedThroughContextSeq 推进。
   */
  async triggerIncremental(runtimeSessionId?: string): Promise<boolean> {
    const lineageId = this.historyPort.lineageId();
    const cursor = this.store.getLineageCursor(lineageId);
    const processed = cursor?.processedThroughContextSeq ?? 0;
    const batch = this.historyPort.freezeBatch({
      afterContextSeqExclusive: processed,
      throughContextSeqInclusive: MAX_FREEZE_HEAD_CONTEXT_SEQ,
      ...(this.maxUnits !== undefined ? { maxUnits: this.maxUnits } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
    });
    if (batch.units.length === 0 || batch.throughContextSeq < processed + 1) {
      return false;
    }
    const outcome = this.queue.enqueue({
      priority: "highest",
      lineageId,
      runtimeSessionId: runtimeSessionId ?? lineageId,
      batch,
    });
    return outcome !== "refused";
  }

  /**
   * Startup recovery：
   *  1. 重放未 ACK 的 committed receipt（Historian commit 后 Context 未
   *     ACK → 启动重放；ACK 幂等，绝不重复生成 Publication）；
   *  2. 未处理窗口重新 freeze + enqueue；
   *  3. 未投递 outbox 由 drainOutbox 重认领。
   */
  async recover(): Promise<void> {
    const lineageId = this.historyPort.lineageId();
    for (const batchRow of this.store.listCommittedBatchesNeedingAck()) {
      if (batchRow.receiptJson === null) {
        continue;
      }
      const receipt = JSON.parse(batchRow.receiptJson) as Parameters<
        ContextRetirementPortV1["acknowledgeHistorianCommit"]
      >[0];
      this.retirementPort.acknowledgeHistorianCommit(receipt);
      this.store.markBatchAcked(batchRow.batchId, new Date(this.nowMs()).toISOString());
    }
    await this.triggerIncremental(lineageId);
  }

  /** Drain ONE job（background pump 循环调用）。 */
  async pumpOnce(): Promise<void> {
    await this.worker.runOnce();
  }

  /**
   * Delivery loop：claim pending outbox rows 并通过 Memory Service 投递。
   * 一行只有从**验证过绑定身份**的 Memory receipt（publicationId +
   * canonicalPayloadHash + contractVersion）才能标记 delivered；缺 client 时
   * 永不伪造 delivered（health 暴露 missing client）。
   */
  async drainOutbox(batchSize = 10): Promise<{
    claimed: number;
    accepted: number;
    rejected: number;
    deferred: number;
  }> {
    const batch = this.service.claimBatch({ batchSize });
    const metrics = { claimed: batch.length, accepted: 0, rejected: 0, deferred: 0 };
    if (this.memoryClient === undefined) {
      metrics.deferred = batch.length;
      return metrics;
    }
    for (const row of batch) {
      const outcome = await this.deliverOne(row);
      if (outcome === "accepted") {
        metrics.accepted += 1;
      } else if (outcome === "rejected") {
        metrics.rejected += 1;
      } else {
        metrics.deferred += 1;
      }
    }
    return metrics;
  }

  private async deliverOne(row: OutboxRow): Promise<"accepted" | "rejected" | "deferred"> {
    if (row.payloadJson === null) {
      return "deferred";
    }
    let publication: unknown;
    try {
      publication = JSON.parse(row.payloadJson);
    } catch {
      this.service.markFailed({
        publicationId: row.publicationId,
        errorCode: "invalid_payload_json",
        maxAttempts: 1,
      });
      return "rejected";
    }
    let outcome: Awaited<ReturnType<MemoryDeliveryClientPort["deliverPublication"]>> | undefined;
    try {
      outcome = await this.memoryClient?.deliverPublication(publication);
    } catch (error) {
      this.recordDeliveryError(row.publicationId, error);
      return "deferred";
    }
    if (outcome === undefined) {
      return "deferred";
    }
    if (outcome.ok) {
      // delivered 只能由"验证过绑定身份"的 Memory receipt 授权（Notion v29：
      // 跨边界一致性以 publicationId + outputHash + Router durable receipt 验证；
      // 本实现绑定 publicationId + canonicalPayloadHash + contractVersion）。
      const envelopePublicationId = (publication as { publicationId?: unknown }).publicationId;
      const receiptPublicationId =
        outcome.receipt.duplicateReplay === true
          ? (outcome.receipt.originalPublicationId ?? outcome.receipt.publicationId)
          : outcome.receipt.publicationId;
      const payloadHashMatches = outcome.receipt.canonicalPayloadHash === row.payloadHash;
      const contractVersionKnown =
        outcome.receipt.contractVersion !== undefined &&
        KNOWN_MEMORY_CONTRACT_VERSIONS.includes(outcome.receipt.contractVersion);
      if (
        typeof envelopePublicationId !== "string" ||
        receiptPublicationId !== envelopePublicationId ||
        !payloadHashMatches ||
        !contractVersionKnown
      ) {
        this.service.markFailed({
          publicationId: row.publicationId,
          errorCode: "memory_receipt_mismatch",
          maxAttempts: 1,
        });
        return "rejected";
      }
      this.service.markDelivered({ publicationId: row.publicationId, receipt: outcome.receipt });
      return "accepted";
    }
    if (outcome.error === "rejected") {
      this.service.markFailed({
        publicationId: row.publicationId,
        errorCode: "memory_rejected",
        maxAttempts: 1,
      });
      return "rejected";
    }
    return "deferred";
  }

  private recordDeliveryError(publicationId: string, error: unknown): void {
    this.deliveryErrors += 1;
    this.lastDeliveryError = `publication ${publicationId}: ${String(
      error instanceof Error ? error.message : error,
    )}`;
  }

  countExhaustedSessions(): number {
    return this.store.countExhaustedSessions();
  }

  async reactivateExhaustedSession(runtimeSessionId: string): Promise<boolean> {
    return this.store.reactivateExhaustedSession(runtimeSessionId);
  }

  /** Compaction 授权（contextSeq 坐标；无 m0/m1 措辞）。 */
  authorizeCompaction(): CompactionAuthorization {
    const lineageId = this.historyPort.lineageId();
    const authorizer = createCompactionAuthorizer(lineageId, {
      historyPort: this.historyPort,
      latestProtectedTailStartContextSeq: () => {
        const latest = this.store.listLatestBatchesByLineage(lineageId, 1)[0];
        return latest === undefined ? undefined : latest.throughContextSeq + 1;
      },
    });
    return authorizer.authorize();
  }

  /** Health/readiness snapshot。 */
  health(): HistorianHealth {
    const lineageId = this.historyPort.lineageId();
    const cursor = this.store.getHistorianCursor(lineageId);
    return {
      ready: !this.draining,
      queue: this.queue.stats(),
      sessionCount: this.store.countSessions(),
      publicationCount: this.store.countPublications(),
      outboxPending: this.store.countOutboxPending(),
      retryExhausted: this.store.countExhaustedSessions(),
      cursor: {
        processedThroughContextSeq: cursor.processedThroughContextSeq,
        lastCommittedCompartmentSequence: cursor.lastCommittedCompartmentSequence,
      },
      memoryDelivery: this.memoryClient === undefined ? "unavailable" : "configured",
      deliveryErrors: this.deliveryErrors,
      lastDeliveryError: this.lastDeliveryError,
    };
  }

  /** Shutdown: stop draining, close the store. */
  close(): void {
    this.draining = true;
    this.store.close();
  }

  private async executeJob(job: HistorianJob): Promise<{ ok: boolean; errorCode?: string }> {
    try {
      const result = this.runner.run({
        batch: job.batch,
        runtimeSessionId: job.runtimeSessionId,
      });
      if (result.status === "validation_failed") {
        return { ok: false, errorCode: result.errorCode ?? "validation_failed" };
      }
      if (result.status === "committed" && result.receipt !== undefined) {
        // Context 幂等 ACK：把 covered units 标记 compartmentalized_pending_bust。
        this.retirementPort.acknowledgeHistorianCommit(result.receipt);
        this.store.markBatchAcked(result.receipt.batchId, new Date(this.nowMs()).toISOString());
        // hot-row reclaim 条件 1：Context ACK 已确认该范围。
        for (const compartmentId of result.receipt.compartmentIds) {
          const views = this.store.listCompartmentReleaseViews(job.lineageId);
          const view = views.find((v) => v.compartmentId === compartmentId);
          if (view !== undefined) {
            this.store.upsertCompartmentRelease({
              ...view,
              contextAckedAt: new Date(this.nowMs()).toISOString(),
            });
          }
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, errorCode: error instanceof Error ? error.message : "unknown" };
    }
  }
}
