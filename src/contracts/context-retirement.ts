/**
 * ContextRetirementPortV1 —— Context 侧 retirement / ACK 窄端口（Phase D + E）。
 *
 * 权威来源：Notion v29 Historian commit protocol + Canonical Schemas
 * Retirement Port：
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
 * `markRepresentedAndRetired` 只能作为成功 canonical BUST full-rebuild 的
 * 同一原子发布事务的一部分调用（ContextStore 事务标志断言，事务外调用
 * fail-closed），并绑定新发布的 `contextGenerationId + contextGenerationHash`；
 * `reclaimRetiredPayloads` 只做物理 GC（回收 retired 单元的 semantic payload）。
 * 不存在 `retireEligible()`、`bustKind` 或 materialization strategy。
 */

import type { HistorianCommitReceiptV1 } from "./historian.js";

/**
 * 一次 retirement 推进的输入（canonical BUST full-rebuild 使用）。
 * `representedThroughContextSeq` / `retiredThroughContextSeq` 为闭区间上限
 * （contextSeq 坐标）；retirement 是 representation 的子集
 * （retired ≤ represented）。
 */
export interface RepresentAndRetireInput {
  contextLineageId: string;
  /** BUST 原子发布的新 generation id（audit 绑定）。 */
  contextGenerationId: string;
  /** 同一发布的 generation hash（audit 绑定）。 */
  contextGenerationHash: string;
  /** 已表示为 P3 的 covered 区间上限（闭区间）。 */
  representedThroughContextSeq: number;
  /** 已退休的 covered 区间上限（闭区间；≤ represented）。 */
  retiredThroughContextSeq: number;
}

/**
 * GC 回收输入（canonical BUST Retirement Port，Notion 形状）：只回收
 * lifecycle_state=retired 的 semantic payload，有界化 maxRows/maxBytes。
 * ContextStore 是 per-lineage 的（实现按自身 lineage 作用域）。
 */
export interface ReclaimRetiredInput {
  /** 单次最多回收的行数（有界化）。 */
  maxRows: number;
  /** 单次最多回收的估算字节数（有界化）。 */
  maxBytes: number;
}

/** 物理 GC 结果。 */
export interface RetirementGcResult {
  /** 实际回收（payload 冷迁移）的行数。 */
  reclaimedRows: number;
  /** 回收的估算 payload 字节数。 */
  reclaimedBytes: number;
  /** 仍待回收的 retired 行数（未超过上限的余量）。 */
  remainingRetiredRows: number;
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
   * 只能作为成功 canonical BUST full-rebuild 的同一原子发布事务的一部分调用
   * （ContextStore 事务标志断言，事务外调用 fail-closed），并绑定新发布的
   * `contextGenerationId + contextGenerationHash`。只有该原子发布成功后，
   * represented/retired watermark 才能推进。P4 单元不持久化、不推进
   * retirement。
   */
  markRepresentedAndRetired(input: RepresentAndRetireInput): void;

  /**
   * 物理 GC：只回收 lifecycle_state=retired 单元的 semantic payload
   * （清除/冷迁移），保留 identity/hash/binding/disposition/archive locator。
   * 返回回收行数/字节。无 retireEligible()。
   */
  reclaimRetiredPayloads(input: ReclaimRetiredInput): RetirementGcResult;
}
