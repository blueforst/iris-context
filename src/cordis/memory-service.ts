/**
 * Phase F（Cordis）：irisMemory —— Memory Integration Coordinator 服务。
 *
 * 权威来源：Notion [Long-Term Memory Service & Plugin Boundary]：
 *  - Memory Integration Coordinator **exactly one**、thin/reconstructable，
 *    在 Identity scope 注册；
 *  - Memory Service Adapter **zero-or-one**（zero-backend 合法 → P4 空）；
 *  - `recall` 是 **P4 专用、仅供 canonical BUST** 调用：任何 invocation-time /
 *    provider-renderer / memory-tool 调用都 fail-closed（抛
 *    MemoryRecallNotAuthorizedError）。P4 只有 canonical BUST 更新路径。
 *
 * 注册语义（fail-closed）：`setAdapter` 是可逆注册 —— 已挂载一个 adapter 时
 * 二次注册（无论同/异 adapter）直接抛 MemoryAdapterConflictError（authority
 * provider 冲突不得"最后注册者获胜"）；返回的 disposer 卸载 adapter 后，槽位
 * 释放，可再注册。注册经 `ctx.effect` 包裹 —— 拥有 fiber 卸载时自动摘除
 * 进程内注册，绝不触碰 durable 状态。
 */

import { Context, Service } from "@deepseek-ai/cordis";

import {
  MemoryIntegrationCoordinator,
  type MemoryServiceAdapter,
  type MemoryServiceStatus,
  type RecallIntent,
  type RecollectionSnapshot,
} from "../memory/memory-integration-coordinator.js";

/** provider 冲突（fail-closed）：已有 adapter 挂载时二次 setAdapter 抛错。 */
export class MemoryAdapterConflictError extends Error {
  readonly code = "iris_memory_adapter_conflict" as const;
  constructor(existing: MemoryServiceAdapter, incoming: MemoryServiceAdapter) {
    super(
      `iris memory: adapter ${incoming.serviceId} cannot be mounted while ` +
        `${existing.serviceId} is mounted (fail closed; provider conflicts never ` +
        "last-writer-win — dispose the current adapter first)",
    );
    this.name = "MemoryAdapterConflictError";
  }
}

/** P4 recall 未授权（fail-closed）：recall 只允许在 canonical BUST 周期内。 */
export class MemoryRecallNotAuthorizedError extends Error {
  readonly code = "iris_memory_recall_not_authorized" as const;
  constructor() {
    super(
      "iris memory: recall is P4/BUST-only — it may only be invoked within a " +
        "canonical BUST cycle (invocation-time recall is fail-closed)",
    );
    this.name = "MemoryRecallNotAuthorizedError";
  }
}

export interface MemoryServiceConfig {
  /** 可注入 coordinator（默认新建；thin/reconstructable）。 */
  coordinator?: MemoryIntegrationCoordinator;
}

export class MemoryService extends Service {
  static inject = [] as const;

  /** 底层 Memory Integration Coordinator（exactly one）。 */
  readonly coordinator: MemoryIntegrationCoordinator;

  /** BUST 周期标志：仅 ContextService.runBustIfPending 打开/关闭。 */
  private bustCycle = false;

  constructor(ctx: Context, config: MemoryServiceConfig = {}) {
    super(ctx, "irisMemory");
    this.coordinator = config.coordinator ?? new MemoryIntegrationCoordinator();
  }

  /**
   * 可逆注册 Memory Service Adapter（zero-or-one）。
   *
   * 返回 disposer（卸载 adapter；unmount 后槽位释放）。fail-closed：
   * 已有 adapter 挂载时二次注册（无论同/异）抛 MemoryAdapterConflictError。
   * 注册/注销都是进程内 effect —— 拥有 fiber 卸载时自动摘除，绝不删除
   * durable Memory 状态（本服务不持有 durable 状态）。
   */
  setAdapter(adapter: MemoryServiceAdapter): () => void | Promise<void> {
    return this.ctx.effect(() => {
      const current = this.coordinator.getAdapter();
      if (current !== undefined) {
        throw new MemoryAdapterConflictError(current, adapter);
      }
      this.coordinator.mount(adapter);
      return () => {
        this.coordinator.unmount();
      };
    }, `irisMemory.setAdapter(${adapter.serviceId})`);
  }

  /** 当前 adapter（zero-or-one；无 → undefined）。 */
  getAdapter(): MemoryServiceAdapter | undefined {
    return this.coordinator.getAdapter();
  }

  /** 是否已配置 backend。 */
  isConfigured(): boolean {
    return this.coordinator.isConfigured();
  }

  /** backend 规范化状态（无 adapter → 'disabled'）。 */
  status(): MemoryServiceStatus {
    return this.coordinator.getStatus();
  }

  /** 最近一次 backend 错误（audit）。 */
  getLastError(): string | undefined {
    return this.coordinator.getLastError();
  }

  /**
   * @internal —— canonical BUST 周期开始标记。只由
   * ContextService.runBustIfPending 调用（P4 唯一更新路径的入口）。
   */
  beginBustCycle(): void {
    this.bustCycle = true;
  }

  /**
   * @internal —— canonical BUST 周期结束标记（finally 中调用）。
   */
  endBustCycle(): void {
    this.bustCycle = false;
  }

  /**
   * @BUST-only —— P4 Recollection recall。
   *
   * 只允许在 canonical BUST 周期内调用（beginBustCycle/endBustCycle 之间；
   * 该周期只由 ContextService.runBustIfPending 进入）。invocation-time /
   * provider-renderer / memory-tool 调用抛 MemoryRecallNotAuthorizedError
   * （fail-closed）—— P4 只有 canonical BUST 更新路径。
   *
   * @returns 规范化的 provider-neutral RecollectionSnapshot。
   */
  async recall(intent: RecallIntent): Promise<RecollectionSnapshot> {
    if (!this.bustCycle) {
      throw new MemoryRecallNotAuthorizedError();
    }
    return this.coordinator.recall(intent);
  }
}
