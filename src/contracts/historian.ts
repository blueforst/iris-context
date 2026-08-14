/**
 * Historian contracts（Phase D 输入的对齐基座）。
 *
 * 本文件只定义 ContextHistoryReadPort 产出的权威 `HistorianBatchV1` 形状
 * （Notion [01 Canonical Schemas] Historian Batch and Receipt）与确定性
 * range hash。完整的 Historian 模块（claim/lease/receipt/processing profile、
 * historian.db、Compartment/Publication）属于后续 Phase D。
 *
 * 字段以权威 schema 为准：batchId / claimId / contextLineageId /
 * fromContextSeq / throughContextSeq / rangeHash / semanticSchemaIds /
 * units: ContextMessageUnitV1[] / estimatedTokens / frozenAt / leaseExpiresAt。
 */

import { createHash, randomUUID } from "node:crypto";

import type { ContextMessageUnitV1, JsonValue } from "./context-v27.js";

/** 权威 Historian batch（Context 在事务中冻结；Historian 不得自行扩大 range）。 */
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

/**
 * 确定性 range hash：sha256 over (contextLineageId, endpoints, ordered
 * unit contextSeq+contextUnitId+contentHash)。同一冻结窗口 + 同一单元序列
 * 必须产生同一 hash（跨 crash/restart 可重放）。
 */
export function historianBatchRangeHash(input: {
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  units: ReadonlyArray<Pick<ContextMessageUnitV1, "contextSeq" | "contextUnitId" | "contentHash">>;
}): string {
  const body = input.units
    .map((unit) => `${unit.contextSeq}:${unit.contextUnitId}:${unit.contentHash}`)
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
