/**
 * Historian contracts（Phase D 输入的对齐基座 + iris-context#2 单 ContextUnit
 * 迁移）。
 *
 * 本文件定义 ContextHistoryReadPort 产出的权威 `HistorianBatchV2` 形状
 * （Notion 2026-08-15 Single ContextUnit Historian Boundary）与确定性
 * range hash。
 *
 * 权威关系（Notion）：
 *   - Historian 直接消费 Context 已接纳的 `ContextUnit`，不再消费另一种
 *     `ContextMessageUnit` 内容 DTO；
 *   - Batch、claim、range、sequence 与 receipt 是处理 envelope/state；其中的
 *     语义成员始终是同一个 `ContextUnit`；
 *   - `contextSeq` 属于 Context ledger/index 和 batch range，不是 ContextUnit
 *     本体字段；kind/disposition/derivation/createdAt 是 sidecar 状态；
 *   - Historian 不创建 HistoryProjectionUnit / HistorianUnit 或语义副本。
 */

import { createHash, randomUUID } from "node:crypto";

import type {
  ContextMessageUnitV1,
  HistorianDisposition,
  JsonValue,
  RawArchiveRefV1,
  SemanticDerivationRefsV1,
} from "./context-v27.js";
import type { ContextUnit } from "./context-unit.js";

/**
 * 一个 Historian batch 成员 = 同一个 `ContextUnit` + 其必需的 sidecar 坐标
 * （accepted ordering / kind / disposition / derivation / createdAt / legacy
 * 溯源）。sidecar 坐标绝不写回 Unit 内容；语义正文只经 `unit.content` 读取。
 */
export interface HistorianBatchUnit {
  /** 同一个 ContextUnit（identity/content/hash 权威；sidecar 坐标不写回 Unit）。 */
  readonly unit: ContextUnit;
  /** accepted ordering（Historian 轴心坐标；Unit 本体无此字段）。 */
  readonly contextSeq: number;
  /** runtime-origin kind（contentSchemaId 派生；P0–P4/派生单元不进入 batch）。 */
  readonly kind?: "user" | "assistant" | "tool_result";
  readonly historianDisposition: HistorianDisposition;
  readonly derivation?: SemanticDerivationRefsV1;
  readonly createdAt: string;
  /** legacy Pi 溯源（迁移行）；新行由 unit.sourceRef（DshMessageRef）承担。 */
  readonly rawArchiveRef?: RawArchiveRefV1;
}

/**
 * 权威 Historian batch（Context 在事务中冻结；Historian 不得自行扩大 range）。
 * units 成员为 `HistorianBatchUnit[]`（每个成员携带同一个 ContextUnit + sidecar）。
 */
export interface HistorianBatchV2 {
  schemaId: "iris.historian_batch.v2";
  batchId: string;
  claimId: string;
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  semanticSchemaIds: string[];
  units: HistorianBatchUnit[];
  estimatedTokens: number;
  frozenAt: string;
  leaseExpiresAt: string;
}

/** @legacy 旧 V1 batch（units 为 ContextMessageUnitV1[]）；仅 legacy 测试/迁移用。 */
export interface HistorianBatchV1 {
  schemaId: "iris.historian_batch.v1";
  batchId: string;
  claimId: string;
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  semanticSchemaIds: string[];
  units: ContextMessageUnitV1[];
  estimatedTokens: number;
  frozenAt: string;
  leaseExpiresAt: string;
}

/** batch 成员的统一读取视图（historian 模块消费；`unit` 始终是同一个 ContextUnit）。 */
export type HistorianBatchMember = HistorianBatchUnit;

/**
 * 确定性 range hash：sha256 over (contextLineageId, endpoints, ordered
 * member contextSeq+unitId+contentHash)。同一冻结窗口 + 同一成员序列
 * 必须产生同一 hash（跨 crash/restart 可重放）。
 */
export function historianBatchRangeHash(input: {
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  units: ReadonlyArray<
    Pick<HistorianBatchUnit, "contextSeq"> & { unit: Pick<ContextUnit, "unitId" | "contentHash"> }
  >;
}): string {
  const body = input.units
    .map((member) => `${member.contextSeq}:${member.unit.unitId}:${member.unit.contentHash}`)
    .join("\n");
  return createHash("sha256")
    .update(
      `${input.contextLineageId}|${input.fromContextSeq}|${input.throughContextSeq}|${body}`,
      "utf8",
    )
    .digest("hex");
}

/** 确定性 token 估计（chars/4；真实 tokenizer 由 Historian profile 接入）。 */
export function estimateSemanticTokens(semanticContent: JsonValue): number {
  return Math.ceil(JSON.stringify(semanticContent).length / 4);
}

/** 生成 batch/claim 身份（claim 每次冻结新建；batch 身份绑定 range）。 */
export function newBatchIdentity(contextLineageId: string, from: number, through: number): string {
  return `batch-${contextLineageId}-${from}-${through}`;
}

export function newClaimId(): string {
  return randomUUID();
}

/**
 * Historian 拥有的权威游标（Notion v29 HistorianCursor）：只以 Context 全局
 * contextSeq 表达。`processedThroughContextSeq` 为 exclusive cursor（下一个
 * eligible batch 从 +1 开始）；`lastCommittedCompartmentSequence` 为最近一次
 * 提交的 lineage-scoped compartment sequence（Compartment 反馈回路水位）。
 * `updatedAt` 为最近更新时刻。
 */
export interface HistorianCursor {
  processedThroughContextSeq: number;
  lastCommittedCompartmentSequence: number;
  updatedAt: string;
}

/**
 * 权威 commit receipt（Notion v29 commit protocol 的"emit HistorianCommitReceipt
 * → Context idempotently ACKs → marks covered units compartmentalized_pending_bust"
 * 步骤）。由 Historian store 在原子 commit 事务内产出；Context 侧
 * ContextRetirementPortV1.acknowledgeHistorianCommit 幂等消费。字段只以
 * [01 Canonical Schemas｜HistorianCommitReceiptV1] 为准。
 */
export interface HistorianCommitReceiptV1 {
  schemaId: "iris.historian_commit_receipt.v1";
  receiptId: string;
  batchId: string;
  claimId: string;
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  compartmentIds: string[];
  publicationIds: string[];
  outputHash: string;
  committedAt: string;
}

/** 确定性 receipt 身份（绑定 batch + claim）。 */
export function newReceiptId(batchId: string, claimId: string): string {
  return `receipt-${batchId}-${claimId}`;
}
