/**
 * ContextRetirementPortV1 的 Context 侧实现（context.db 唯一权威 owner）。
 *
 * Context 模块实现窄 retirement 端口；Historian 只消费 VALUE（receipt），
 * 绝不持有 context.db 句柄。
 *   - `acknowledgeHistorianCommit` 委托给 ContextStore（幂等标记
 *     compartmentalized_pending_bust）；
 *   - `markRepresentedAndRetired` 只接受成功 canonical BUST full-rebuild
 *     原子发布事务内的调用：事务由 BustCoordinator（唯一调用方）在
 *     ContextStore 上开启/提交，本实现直接委托 store；store 内的事务标志
 *     断言保证事务外调用 fail-closed（绝不允许绕过 BUST 的逻辑退休），并
 *     绑定新 generation id+hash；
 *   - `reclaimRetiredPayloads` 只回收 retired 单元的 semantic payload
 *     （物理 GC，保留 identity/hash/binding/disposition/archive locator）。
 */

import type {
  ContextRetirementPortV1,
  ReclaimRetiredInput,
  RepresentAndRetireInput,
  RetirementGcResult,
} from "../contracts/context-retirement.js";
import type { HistorianCommitReceiptV1 } from "../contracts/historian.js";
import type { ContextStore } from "./context-store.js";

/** 用 ContextStore 装配 ContextRetirementPortV1。 */
export function createContextRetirementPort(store: ContextStore): ContextRetirementPortV1 {
  return {
    acknowledgeHistorianCommit(receipt: HistorianCommitReceiptV1): void {
      store.acknowledgeHistorianCommit(receipt);
    },
    markRepresentedAndRetired(input: RepresentAndRetireInput): void {
      // 事务边界由 BustCoordinator 在 store 上开启；store 的事务标志断言保证
      // 事务外调用 fail-closed（本端口绝不自行开启事务 —— 推进 retirement
      // 只能是成功 BUST 原子发布事务的一部分）。
      store.markRepresentedAndRetired(input);
    },
    reclaimRetiredPayloads(input: ReclaimRetiredInput): RetirementGcResult {
      return store.reclaimRetiredPayloads(input);
    },
  };
}
