/**
 * Historian runner（Phase D）—— batch 驱动、lineage-scoped。
 *
 * v29 commit protocol：Context freezes batch + claim lease → Historian
 * validates batch identity/hash → produce CompartmentRevision[] +
 * provider-neutral MemoryObservation[]/MemoryPublication → atomic commit →
 * emit HistorianCommitReceipt。claim 后未 commit：lease 到期后重试相同 batch。
 *
 * 本 runner 消费 manager 冻结的 batch（job 携带），PURE 验证（endpoint
 * anchor + range hash）后在同一原子事务内：persist batch claim → commitHook
 * （Compartment + Publication + outbox，产出 receipt）→ mark batch committed
 * → advance lineage cursor。
 *
 * 失败路径：验证失败绝不推进 cursor（status=validation_failed，job 以相同
 * batch 重试）；存储错误抛出 → 调用方 requeue。receipt 返回给调用方（manager
 * 负责 ContextRetirementPortV1.acknowledgeHistorianCommit 幂等 ACK）。
 */

import type { HistorianBatchV1, HistorianCommitReceiptV1 } from "../contracts/historian.js";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";
import { buildCompartment, type BuiltCompartment } from "./historian-compartment.js";
import { validateRange } from "./historian-analysis.js";
import type { HistorianSemanticAdapterRegistry } from "./semantic-adapter-registry.js";
import type { HistorianStore } from "./historian-store.js";

export interface RunnerCommitHook {
  /**
   * 在 runner 的 BEGIN..COMMIT 内调用；必须抛错使整个事务回滚（cursor 永不
   * 推进）。返回 HistorianCommitReceiptV1（commit protocol 的 emit receipt）。
   */
  commitBatch(input: {
    batch: HistorianBatchV1;
    built: BuiltCompartment;
    /** batch claim 时冻结的 processing profile id。 */
    processingProfileId: string;
    /** durable cursor BEFORE this commit（chain 元数据）。 */
    previousProcessedThroughContextSeq: number;
  }): HistorianCommitReceiptV1;
}

export interface HistorianRunnerOptions {
  store: HistorianStore;
  /** Context-owned history read/claim port —— 唯一正常语义输入。 */
  historyPort: ContextHistoryReadPort;
  /** semantic adapter 注册表（frozen processing profile；可选）。 */
  registry?: HistorianSemanticAdapterRegistry;
  /** 原子 publication 事务 hook（B5）。 */
  commitHook?: RunnerCommitHook;
}

export interface RunnerResult {
  /** True when a safe prefix was committed (cursor advanced + receipt emitted). */
  committed: boolean;
  commitThroughContextSeq: number;
  status: "committed" | "nothing_new" | "validation_failed";
  errorCode?: string;
  detail?: string;
  receipt?: HistorianCommitReceiptV1;
}

export class HistorianRunner {
  private readonly store: HistorianStore;
  private readonly historyPort: ContextHistoryReadPort;
  private readonly registry: HistorianSemanticAdapterRegistry | undefined;
  private readonly commitHook: RunnerCommitHook | undefined;

  constructor(options: HistorianRunnerOptions) {
    this.store = options.store;
    this.historyPort = options.historyPort;
    this.registry = options.registry;
    this.commitHook = options.commitHook;
  }

  /**
   * Run：消费冻结 batch → PURE validate → build → atomic commit。
   * 验证失败不抛错（返回 validation_failed，调用方以相同 batch 重试）；
   * 存储错误抛出（调用方 requeue，cursor 从未推进）。
   */
  run(input: { batch: HistorianBatchV1; runtimeSessionId?: string }): RunnerResult {
    const { batch } = input;
    const lineageId = this.historyPort.lineageId();
    if (batch.contextLineageId !== lineageId) {
      throw new Error(
        `historian runner: batch lineage ${batch.contextLineageId} != port lineage ${lineageId} (fail closed)`,
      );
    }
    const runtimeSessionId = input.runtimeSessionId ?? lineageId;
    const cursor = this.store.getLineageCursor(lineageId);
    const processedThroughContextSeq = cursor?.processedThroughContextSeq ?? 0;
    const fromContextSeq = processedThroughContextSeq + 1;

    // PURE validation（claim anchor + range hash + empty window）。顺序在
    // nothing_new 检查之前：一个锚定错误的批（stale/漂移）必须 fail-closed
    // 报告，而不是静默当作 nothing_new。
    const outcome = validateRange({ batch, unprocessedFromContextSeq: fromContextSeq });
    if (!outcome.ok) {
      if (outcome.errorCode === "no_safe_prefix") {
        return {
          committed: false,
          commitThroughContextSeq: processedThroughContextSeq,
          status: "nothing_new",
        };
      }
      return {
        committed: false,
        commitThroughContextSeq: processedThroughContextSeq,
        status: "validation_failed",
        errorCode: outcome.errorCode,
        detail: outcome.detail,
      };
    }

    // Build CompartmentRevision（anti-echo 分类）。
    const nextCompartmentSequence = this.store.maxCompartmentSequence(lineageId) + 1;
    const built = buildCompartment({
      lineageId,
      runtimeSessionId,
      compartmentSequence: nextCompartmentSequence,
      units: batch.units,
    });
    if (built === null) {
      return {
        committed: false,
        commitThroughContextSeq: processedThroughContextSeq,
        status: "nothing_new",
      };
    }

    // batch claim 时冻结 processing profile。
    const processingProfileId = this.registry?.frozenProcessingProfile().profileId ?? "no-adapters";

    // ONE 原子事务：batch claim（lease 刷新）→ commitHook → batch committed
    // → lineage cursor 推进。
    this.store.begin();
    try {
      this.store.upsertBatchClaim(batch);
      if (this.commitHook === undefined) {
        throw new Error("historian runner: commit hook is required for publication commits");
      }
      const receipt = this.commitHook.commitBatch({
        batch,
        built,
        processingProfileId,
        previousProcessedThroughContextSeq: processedThroughContextSeq,
      });
      this.store.markBatchCommitted(batch.batchId, receipt);
      this.store.upsertLineageCursor(
        lineageId,
        outcome.commitThroughContextSeq,
        outcome.commitThroughContextSeq,
      );
      this.store.upsertSessionState({
        runtimeSessionId,
        status: "active",
        processedThroughContextSeq: outcome.commitThroughContextSeq,
        updatedAt: new Date(this.store.now()).toISOString(),
      });
      this.store.commit();
      return {
        committed: true,
        commitThroughContextSeq: outcome.commitThroughContextSeq,
        status: "committed",
        receipt,
      };
    } catch (error) {
      this.store.rollback();
      throw error;
    }
  }
}
