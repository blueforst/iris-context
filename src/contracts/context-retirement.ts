/**
 * ContextRetirementPortV1 —— Context 侧 retirement / ACK 窄端口（Phase D）。
 *
 * 权威来源：Notion v29 Historian commit protocol：
 *
 *   Context freezes batch + claim lease
 *   → Historian validates batch identity/hash
 *   → produce CompartmentRevision[] + provider-neutral MemoryObservation[] / MemoryPublication
 *   → atomic historian.db commit
 *   → emit HistorianCommitReceipt
 *   → Context idempotently ACKs receipt
 *   → Context marks covered units `compartmentalized_pending_bust`
 *   → successful canonical BUST rebuild atomically marks represented + retired
 *   → Context GC only reclaims payloads already marked retired
 *
 * 本端口只把 VALUE 暴露给 Historian（receipt 为不可变值对象）；绝不泄漏
 * context.db 句柄 / Repository / ORM entity。`acknowledgeHistorianCommit`
 * 由 Historian 在 commit 后调用，幂等（重复 ACK 不改变结果）。
 *
 * `markRepresentedAndRetired` / `reclaimRetiredPayloads` 属于 Phase E
 * （canonical BUST full-rebuild）。本阶段只定义契约：占位实现抛错（fail
 * closed）——绝不允许在 BUST 之前推进 represented/retired 水位。
 */

import type { HistorianCommitReceiptV1 } from "./historian.js";

/** 一次 retirement 推进的输入（Phase E 的 canonical BUST rebuild 使用）。 */
export interface RepresentAndRetireInput {
  contextLineageId: string;
  /** BUST full-rebuild 后已表示为 P3 的 covered 区间（闭区间）。 */
  throughContextSeq: number;
  /** 触发 rebuild 的 Historian receipt（审计）。 */
  receipt: HistorianCommitReceiptV1;
}

/** GC 回收输入（Phase E）：只回收 lifecycle_state=retired 的 payload。 */
export interface ReclaimRetiredInput {
  contextLineageId: string;
  throughContextSeq: number;
}

/**
 * ContextRetirementPortV1：Historian → Context 的窄 retirement 端口。
 * Context 模块是 context.db 的唯一权威 owner；本端口是 Context 侧实现。
 */
export interface ContextRetirementPortV1 {
  /**
   * 幂等 ACK：把 receipt covered 的 units（context_seq ∈ [from..through]，
   * lifecycle_state ∈ {committed, historian_eligible, historian_claimed}）
   * 标记为 `compartmentalized_pending_bust`。重复 ACK / 已 ACK 范围不改变
   * 结果（不向前推进任何 represented/retired 水位）。
   */
  acknowledgeHistorianCommit(receipt: HistorianCommitReceiptV1): void;

  /**
   * Phase E 占位：只有成功的 canonical BUST full-rebuild 事务才能推进
   * represented/retired 水位。本阶段实现 fail-closed（抛
   * NotImplementedError），禁止任何绕过 BUST 的逻辑退休。
   */
  markRepresentedAndRetired(input: RepresentAndRetireInput): void;

  /**
   * Phase E 占位：GC 只回收已 retired 的 payload。本阶段实现 fail-closed。
   */
  reclaimRetiredPayloads(input: ReclaimRetiredInput): void;
}

/** Phase E 未实现时抛出的确定性错误（fail closed）。 */
export class RetirementNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `ContextRetirementPortV1.${operation}: canonical BUST full-rebuild retirement ` +
        "(markRepresentedAndRetired / reclaimRetiredPayloads) is Phase E scope; " +
        "refusing to advance represented/retired watermarks before a successful BUST rebuild",
    );
    this.name = "RetirementNotImplementedError";
  }
}
