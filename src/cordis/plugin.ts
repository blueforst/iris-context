/**
 * Phase F（Cordis）：iris-context 装配插件 + Identity scope 装配点。
 *
 * `createIrisContextPlugin(config)` —— 单个 root plugin（apply 函数）：
 *   1. 打开 historian.db（装配点持有；irisHistorian 复用同一句柄）；
 *   2. 注册 `irisMemory`（MemoryIntegrationCoordinator；zero-or-one adapter）；
 *   3. 注册 `irisContext`（ContextStore + ContextAdmission + BustCoordinator），
 *      `open(dataRoot)` 作为可逆 effect（fiber unload 自动 close）；
 *   4. 加载 `irisHistorian`（inject=['irisContext']；PENDING 直到 Context
 *      ACTIVE —— 不 await，避免加载顺序死锁）；
 *   5. 注册 auto-BUST 监听（`iris/historian-batch-committed` →
 *      requestBust；随 fiber 清理）。
 *
 * 单向依赖：Ledger → Historian → Compartment Source → Materializer → BUST/
 * Retention。装配点是唯一解析"value 层循环"的地方：committed Compartment
 * 窄端口由装配点从 HistorianStore 适配后以 value 注入 BustCoordinator；
 * service 层 inject 只有 irisHistorian → irisContext（不反向）。
 *
 * Scope 结构（Notion Composition v29）：Deployment/Root → Identity Scope →
 * Runtime Agent Scope。services 在 Identity scope 注册；`installIrisIdentityScope`
 * 明确标记 Identity 装配点。Runtime Agent scope 是 Identity 之下的独立
 * fiber，其 dispose 只清理该 agent 的进程内注册，绝不 dispose Identity
 * services、也绝不触碰 durable DB/Compartment/Publication/receipt/archive。
 *
 * Reversible effects：本插件所有注册（provide、event listener、open 的
 * close、historian.db 句柄）都是 effect —— unload 只摘进程内注册；durable
 * state 由专门服务持有、以稳定 id 键控，unload 绝不删除。
 */

import { Context, type Disposable, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import { join } from "node:path";

import type { ContextStoreOpenOptions } from "../context/context-store.js";
import type { CommittedCompartmentReadPort } from "../context/committed-compartment-read-port.js";
import { createCommittedCompartmentReadPort } from "../context/committed-compartment-read-port.js";
import { HistorianStore } from "../historian/historian-store.js";
import type { MemoryDeliveryClientPort } from "../historian/historian-manager.js";
import { ContextService, deriveLineageId } from "./context-service.js";
import { HistorianService } from "./historian-service.js";
import { MemoryService } from "./memory-service.js";

/** Identity scope 标记（Symbol，避免与任意字符串属性冲突）。 */
export const IRIS_IDENTITY_SCOPE: unique symbol = Symbol("iris.identity-scope");

/** Identity scope context：带 IRIS_IDENTITY_SCOPE 标记的子 context。 */
export interface IdentityScopeContext extends Context {
  [IRIS_IDENTITY_SCOPE]: boolean;
}

export interface IrisHistorianOptions {
  claimLeaseMs?: number;
  maxQueuedJobs?: number;
  maxAttempts?: number;
  maxUnits?: number;
  maxTokens?: number;
  /** Memory Service 投递客户端（可选）。 */
  memoryClient?: MemoryDeliveryClientPort;
  /** 启动 recovery（默认 true）。 */
  recoverOnStart?: boolean;
}

export interface IrisContextPluginConfig {
  /** data root（context.db / historian.db 所在目录）。 */
  dataRoot: string;
  /** identity-level lineage id；缺省 = deriveLineageId(dataRoot)。 */
  lineageId?: string;
  /** ContextStore 打开选项（cap 注入等）。 */
  contextStore?: ContextStoreOpenOptions;
  /** P4 recall 预算上限。 */
  p4MaxCandidates?: number;
  maxPendingRequests?: number;
  maxPendingEvidencePerRequest?: number;
  now?: () => string;
  nowMs?: () => number;
  /** 装配选项：是否同时装配 irisHistorian（默认 true）。false 时只注册
   *  irisMemory + irisContext（Context 无 Historian 的合法配置；测试/部分
   *  装配用）。 */
  withHistorian?: boolean;
  historian?: IrisHistorianOptions;
}

/** 零 Compartment 的窄读端口（withHistorian=false 时 P3 空态）。 */
const EMPTY_COMMITTED_COMPARTMENTS: CommittedCompartmentReadPort = {
  listCommitted: () => [],
};

/**
 * 创建 iris-context 装配插件（apply 函数插件）。
 *
 * @param config 装配配置（dataRoot/lineageId 等）。
 * @returns 可在 `new Context()` 上经 `ctx.plugin(...)` 挂载的插件。
 */
export function createIrisContextPlugin(config: IrisContextPluginConfig): Plugin.Function {
  const apply = (ctx: Context): Disposable => {
    const lineageId = config.lineageId ?? deriveLineageId(config.dataRoot);
    const withHistorian = config.withHistorian !== false;

    // 1. historian.db（装配点持有；irisHistorian 复用同一句柄）。
    const historianStore = withHistorian
      ? HistorianStore.open({
          databasePath: join(config.dataRoot, "historian.db"),
          ...(config.nowMs !== undefined ? { nowMs: config.nowMs } : {}),
        })
      : undefined;
    const committedCompartments: CommittedCompartmentReadPort =
      historianStore === undefined
        ? EMPTY_COMMITTED_COMPARTMENTS
        : createCommittedCompartmentReadPort(historianStore);

    // 2. irisMemory（zero-or-one adapter；BUST-only recall 授权门）。
    const memoryService = new MemoryService(ctx);

    // 3. irisContext（Identity scope；open 是可逆 effect）。
    const contextService = new ContextService(ctx, {
      lineageId,
      committedCompartments,
      memoryService,
      ...(config.p4MaxCandidates !== undefined ? { p4MaxCandidates: config.p4MaxCandidates } : {}),
      ...(config.maxPendingRequests !== undefined
        ? { maxPendingRequests: config.maxPendingRequests }
        : {}),
      ...(config.maxPendingEvidencePerRequest !== undefined
        ? { maxPendingEvidencePerRequest: config.maxPendingEvidencePerRequest }
        : {}),
      ...(config.now !== undefined ? { now: config.now } : {}),
    });
    const closeContext = ctx.effect(
      () =>
        contextService.open(config.dataRoot, {
          ...(config.contextStore !== undefined
            ? { contextStoreOptions: config.contextStore }
            : {}),
        }),
      "irisContext.open",
    );

    if (withHistorian && historianStore !== undefined) {
      // 4. irisHistorian（inject=['irisContext']；PENDING 直到 Context ACTIVE）。
      //    不 await —— 本 fiber ACTIVE 时自动加载（避免加载顺序死锁）。
      const historianFiber = ctx.plugin(HistorianService, {
        store: historianStore,
        ...(config.nowMs !== undefined ? { nowMs: config.nowMs } : {}),
        ...(config.historian?.claimLeaseMs !== undefined
          ? { claimLeaseMs: config.historian.claimLeaseMs }
          : {}),
        ...(config.historian?.maxQueuedJobs !== undefined
          ? { maxQueuedJobs: config.historian.maxQueuedJobs }
          : {}),
        ...(config.historian?.maxAttempts !== undefined
          ? { maxAttempts: config.historian.maxAttempts }
          : {}),
        ...(config.historian?.maxUnits !== undefined
          ? { maxUnits: config.historian.maxUnits }
          : {}),
        ...(config.historian?.maxTokens !== undefined
          ? { maxTokens: config.historian.maxTokens }
          : {}),
        ...(config.historian?.memoryClient !== undefined
          ? { memoryClient: config.historian.memoryClient }
          : {}),
        ...(config.historian?.recoverOnStart !== undefined
          ? { recoverOnStart: config.historian.recoverOnStart }
          : {}),
      });
      // 不 await —— 本 fiber ACTIVE 时自动加载（避免加载顺序死锁）。
      void Promise.resolve(historianFiber).catch((error: unknown) => {
        ctx.logger("iris").error(error);
      });
    }

    // 5. auto-BUST 监听（可逆）：historian batch commit → canonical BUST
    //    request（P4/Compartment 变更的唯一下游触发）。
    ctx.on("iris/historian-batch-committed", (receipt) => {
      if (contextService.isOpen()) {
        contextService.requestBust("historian_compartment_committed", {
          schemaId: "iris.bust_evidence.v1",
          receiptIds: [receipt.receiptId],
        });
      }
    });

    // 6. 兜底：unload 时关闭 historian.db 句柄（idempotent —— HistorianService
    //    也会在自身 unload 关闭；若其从未加载（PENDING 即卸载），这里兜底）。
    if (historianStore !== undefined) {
      ctx.effect(
        () => () => {
          historianStore.close();
        },
        "iris-context.historian-store",
      );
    }

    // 返回 open 的 disposer（close）：fiber unload 时逆序执行全部 effect，
    // 其中包含本 disposer（closeContext）→ 只摘进程内句柄，durable 保留。
    return closeContext;
  };

  // 函数插件的 `name` 属性只读 —— 用 defineProperty 写元数据（inject/provide
  // 供 loader/registry 可见）。
  const plugin = apply as Plugin.Function;
  Object.defineProperty(plugin, "name", { value: "iris-context" });
  Object.defineProperty(plugin, "inject", { value: [], enumerable: true });
  Object.defineProperty(plugin, "provide", {
    value: ["irisContext", "irisHistorian", "irisMemory"],
    enumerable: true,
  });
  return plugin;
}

/**
 * 在 ctx 上装配 iris services（完整插件；等价于
 * `ctx.plugin(createIrisContextPlugin(config))`）。
 *
 * @returns 插件 fiber（await 等加载完成；dispose 可逆卸载）。
 */
export function installIrisContext(
  ctx: Context,
  config: IrisContextPluginConfig,
): Fiber & PromiseLike<Fiber> {
  return ctx.plugin(createIrisContextPlugin(config));
}

/**
 * 标记 Identity scope 装配点。
 *
 * 返回一个带 IRIS_IDENTITY_SCOPE 标记的子 context。调用方应在此 ctx 上挂载
 * iris services（`identity.plugin(createIrisContextPlugin(config))`）。
 *
 * Scope 语义（Notion Composition v29）：Deployment/Root → Identity Scope →
 * Runtime Agent Scope。Cordis core 无 `ctx.scope` —— 这里用 `extend()` 的
 * meta 标记 + 文档约定 + 测试证明"Runtime Agent scope dispose 不 dispose
 * Identity services"（Agent scope 是 Identity 之下的独立 fiber，其 dispose
 * 只清理该 agent 的进程内注册，绝不触碰 Identity services / durable 状态）。
 *
 * @param ctx 当前 context（Root/Deployment）。
 * @returns Identity scope context（meta 标记）。
 */
export function installIrisIdentityScope(ctx: Context): IdentityScopeContext {
  return ctx.extend({ [IRIS_IDENTITY_SCOPE]: true }) as IdentityScopeContext;
}
