/**
 * Phase F（Cordis）：irisHistorian —— Historian 服务（Identity scope）。
 *
 * 组合 HistorianStore（historian.db 唯一 owner）+ HistorianManager（B1–B7
 * 接线：freeze/enqueue/worker/commit/receipt/ACK/outbox/recovery/health）。
 *
 * 依赖（单向 inject）：`static inject = ['irisContext']` —— 本服务只经
 * irisContext 暴露的窄端口（historyPort / retirementPort）消费 Context 的
 * VALUE，绝不反向拥有 Context。依赖未齐备时 fiber 保持 PENDING，直到
 * irisContext ACTIVE 才加载（Cordis 自动依赖重解析）。
 *
 * Reversible effects：
 *  - `registerSemanticAdapter(adapter)` 是可逆注册（HistorianSemanticAdapterRegistry
 *    seam；ownership-scoped —— 同一 semanticSchemaId 二次注册抛错）；拥有
 *    fiber 卸载时自动摘除；
 *  - 关闭 historian.db 句柄是可逆 effect（unload 执行；durable 行保留）；
 *  - 所有 event listener / 调度都经 `ctx.on` / `ctx.effect`，随 fiber 清理。
 *
 * Scope：本服务在 Identity scope 注册；Runtime Agent scope dispose 不影响
 * Identity services，也不触碰 durable historian.db。
 */

import { Context, Service } from "@deepseek-ai/cordis";

import type { HistorianCommitReceiptV1 } from "../contracts/historian.js";
import {
  HistorianManager,
  type HistorianHealth,
  type MemoryDeliveryClientPort,
} from "../historian/historian-manager.js";
import type { CompactionAuthorization } from "../historian/compaction-trigger.js";
import {
  HistorianSemanticAdapterRegistry,
  type FrozenProcessingProfile,
  type SemanticAdapter,
} from "../historian/semantic-adapter-registry.js";
import { HistorianStore } from "../historian/historian-store.js";

export interface HistorianServiceConfig {
  /**
   * 已打开的 historian.db（装配路径 —— 装配点打开后传入，本服务持有并
   * 在 unload 时关闭）。未提供时用 databasePath 独立打开。
   */
  store?: HistorianStore;
  /** 独立打开路径（未提供 store 时必填）。 */
  databasePath?: string;
  nowMs?: () => number;
  claimLeaseMs?: number;
  maxQueuedJobs?: number;
  maxAttempts?: number;
  /** freeze 批量有界化提示。 */
  maxUnits?: number;
  maxTokens?: number;
  /** Memory Service 投递客户端（可选；缺省 outbox 永不标记 delivered）。 */
  memoryClient?: MemoryDeliveryClientPort;
  /** 启动（[Service.init]）时是否执行 Historian startup recovery（默认 true）。 */
  recoverOnStart?: boolean;
}

/**
 * irisHistorian —— Historian 服务。HistorianStore + HistorianManager；
 * 经 inject 消费 irisContext 的窄端口。
 */
export class HistorianService extends Service {
  static inject = ["irisContext"] as const;

  readonly store: HistorianStore;
  readonly registry: HistorianSemanticAdapterRegistry;
  readonly manager: HistorianManager;

  private readonly config: HistorianServiceConfig;
  private readonly lineageId: string;

  constructor(ctx: Context, config: HistorianServiceConfig) {
    super(ctx, "irisHistorian");
    this.config = config;
    // inject=['irisContext']：本构造器只在 irisContext ACTIVE 时运行。
    const context = ctx.irisContext;
    this.lineageId = context.lineageId;
    const providedStore = config.store;
    const databasePath = config.databasePath;
    if (providedStore !== undefined) {
      this.store = providedStore;
    } else {
      if (databasePath === undefined) {
        throw new Error("iris historian: either store or databasePath is required (fail closed)");
      }
      this.store = HistorianStore.open({
        databasePath,
        ...(config.nowMs !== undefined ? { nowMs: config.nowMs } : {}),
      });
    }
    this.registry = new HistorianSemanticAdapterRegistry();
    this.manager = new HistorianManager({
      store: this.store,
      historyPort: context.historyPort,
      retirementPort: context.retirementPort,
      registry: this.registry,
      ...(config.memoryClient !== undefined ? { memoryClient: config.memoryClient } : {}),
      ...(config.nowMs !== undefined ? { nowMs: config.nowMs } : {}),
      ...(config.claimLeaseMs !== undefined ? { claimLeaseMs: config.claimLeaseMs } : {}),
      ...(config.maxQueuedJobs !== undefined ? { maxQueuedJobs: config.maxQueuedJobs } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
      ...(config.maxUnits !== undefined ? { maxUnits: config.maxUnits } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    });
    // 可逆 effect：fiber unload → 关闭 historian.db 句柄（durable 行保留）。
    ctx.effect(
      () => () => {
        this.store.close();
      },
      "irisHistorian.close",
    );
  }

  /** 类插件构造后钩子（仅经 ctx.plugin 加载时运行）：startup recovery。 */
  [Service.init](): void | Promise<void> {
    if (this.config.recoverOnStart !== false) {
      return this.recover();
    }
  }

  // ---- 增量 / 队列 / 投递 ------------------------------------------------

  /** Active incremental trigger（lineage-scoped）：freeze + enqueue highest。 */
  triggerIncremental(runtimeSessionId?: string): Promise<boolean> {
    return this.manager.triggerIncremental(runtimeSessionId);
  }

  /**
   * Drain ONE job（background pump）。若本 pump 推进了
   * processedThroughContextSeq（即原子提交了一个 batch），发出 typed event
   * `iris/historian-batch-committed`（receipt）—— 下游 facet（如装配点的
   * auto-BUST 监听）据此 requestBust。
   */
  async pumpOnce(): Promise<void> {
    const before = this.manager.health().cursor.processedThroughContextSeq;
    await this.manager.pumpOnce();
    const after = this.manager.health().cursor.processedThroughContextSeq;
    if (after > before) {
      const latest = this.store.listLatestBatchesByLineage(this.lineageId, 1)[0];
      const receiptJson = latest?.receiptJson;
      if (receiptJson !== undefined && receiptJson !== null) {
        const receipt = JSON.parse(receiptJson) as HistorianCommitReceiptV1;
        this.ctx.emit("iris/historian-batch-committed", receipt);
      }
    }
  }

  /** Delivery loop：claim pending outbox rows 并经 Memory Service 投递。 */
  drainOutbox(batchSize?: number): Promise<{
    claimed: number;
    accepted: number;
    rejected: number;
    deferred: number;
  }> {
    return this.manager.drainOutbox(batchSize);
  }

  /** Startup recovery：重放未 ACK receipt + 未处理窗口重新 freeze + 未投递 outbox。 */
  recover(): Promise<void> {
    return this.manager.recover();
  }

  // ---- semantic adapter seam（可逆）---------------------------------------

  /**
   * 可逆注册 semantic adapter（ownership-scoped）。返回 disposer；拥有
   * fiber 卸载时自动摘除。同一 semanticSchemaId 二次注册抛
   * SemanticAdapterConflictError（fail-closed）。
   */
  registerSemanticAdapter(adapter: SemanticAdapter): () => void | Promise<void> {
    return this.ctx.effect(() => {
      this.registry.registerAdapter(adapter);
      return () => {
        this.registry.removeAdapter(adapter);
      };
    }, `irisHistorian.registerSemanticAdapter(${adapter.version})`);
  }

  /** schemaId 的 owner adapter（无 → undefined）。 */
  getAdapter(schemaId: string): SemanticAdapter | undefined {
    return this.registry.getAdapter(schemaId);
  }

  /** 已注册的独立 adapter（去重）。 */
  registeredAdapters(): SemanticAdapter[] {
    return this.registry.registeredAdapters();
  }

  /** 冻结当前 processing profile（batch claim 时快照）。 */
  frozenProcessingProfile(): FrozenProcessingProfile {
    return this.registry.frozenProcessingProfile();
  }

  // ---- health / audit -----------------------------------------------------

  /** Health/readiness snapshot。 */
  health(): HistorianHealth {
    return this.manager.health();
  }

  countExhaustedSessions(): number {
    return this.manager.countExhaustedSessions();
  }

  /** Compaction 授权（contextSeq 坐标）。 */
  authorizeCompaction(): CompactionAuthorization {
    return this.manager.authorizeCompaction();
  }
}
