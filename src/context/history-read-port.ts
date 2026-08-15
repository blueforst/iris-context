/**
 * R3-P1 + v27–v29：ContextHistoryReadPort —— 跨库窄读取端口（Context lineage →
 * Historian）。
 *
 * 权威来源：Notion 2026-08-15 —— Historian 只通过 Context semantic history 消费
 * 统一 ContextUnit（ContextHistoryReadPort，HistorianBatchV2），绝不消费 provider
 * wire / Session transcript。本端口只把 Context 坐标暴露为 VALUE（contextSeq、
 * content hash、状态字符串、JsonValue payload），绝不向消费方泄漏 context.db
 * 的句柄、Repository / ORM entity / 具体 Adapter，也不建立跨库外键。
 *
 * 跨库规则（AGENTS.md）：本端口是窄、版本化的契约；batch 形状以
 * src/contracts/historian.ts（权威 HistorianBatchV2）为准。
 */

import {
  estimateSemanticTokens,
  historianBatchRangeHash,
  newBatchIdentity,
  newClaimId,
  type HistorianBatchUnit,
  type HistorianBatchV2,
} from "../contracts/historian.js";
import type { ContextUnit } from "../contracts/context-unit.js";
import type { ContextLineage, ContextStore } from "./context-store.js";

/** Context lineage 状态（与 context_lineages.emergency_state 语义同源）。 */
export type LineageStatus = "ok" | "transform_unavailable" | "emergency_fail_closed";

/** 已物化边界（values-only，跨库安全：全是序号 / 哈希 / 状态字符串）。 */
export interface MaterializedLineageBoundary {
  /** lineage 的 context_seq 空间 watermark（ContextMessageUnit 序号）。 */
  representedThroughContextSeq: number;
  /**
   * watermark 对应的 entrySeq（MAX(entry_seq) over context_seq <= watermark
   * 且 entry_seq IS NOT NULL 的单元；archive attribution）。null = watermark
   * 为 0 或该前缀内没有任何携带 entry_seq 的单元。
   */
  representedThroughEntrySeq: number | null;
  lineageStatus: LineageStatus;
  providerProfileId: string;
}

/**
 * R3-P1：窄读取端口契约。只暴露 VALUE，绝不暴露 context.db 内部对象。
 * 缺 lineage（session 尚无 context_lineages 行）→ fail-closed 抛出。
 */
export interface ContextHistoryReadPort {
  getMaterializedBoundary(runtimeSessionId: string): MaterializedLineageBoundary;

  /** 本 data root 的权威 identity-level Context lineage id（one per data root）。 */
  lineageId(): string;

  /**
   * Context-owned CLAIM —— Historian 的唯一正常语义 batch selector。按
   * identity-level lineage 的全局 contextSeq 冻结不可变、可重放的
   * HistorianBatchV1（权威形状见 src/contracts/historian.ts）。batch
   * membership/order/identity 只由 Context 坐标决定；runtimeSessionId、entry
   * ids、entry ranges 只是可选 attribution，缺失不改变 batch。
   */
  claimHistorianBatch(input: {
    afterContextSeqExclusive: number;
    throughContextSeqInclusive: number;
  }): HistorianBatchV2;

  /**
   * Phase D（v29 freezeBatch）：Context 冻结完整 semantic boundary 并返回
   * 有限、不可变、带 rangeHash 与 claim lease 的 HistorianBatchV1。
   * 与 claimHistorianBatch 同一批选择语义；freezeBatch 显式表达
   * "Context 在事务中冻结 + claim lease"（frozenAt / leaseExpiresAt /
   * claimId 每次新建）。Historian 不得扩大 range、不得绕开
   * historianDisposition、不得回读 Session 修补边界。可选 maxUnits/maxTokens
   * 是批量有界化提示（不改变批内 membership 的 Context 坐标权威性）。
   */
  freezeBatch(input: {
    afterContextSeqExclusive: number;
    throughContextSeqInclusive: number;
    maxUnits?: number;
    maxTokens?: number;
  }): HistorianBatchV2;
}

/** 纯推导（可测）：lineageStatus 与 ContextStore 的 emergency 机制一致。 */
export function deriveLineageStatus(
  lineage: Pick<ContextLineage, "emergencyState" | "lastTransformError">,
): LineageStatus {
  if (lineage.emergencyState === "emergency_fail_closed") {
    return "emergency_fail_closed";
  }
  if (lineage.lastTransformError !== null && lineage.lastTransformError !== undefined) {
    return "transform_unavailable";
  }
  return "ok";
}

/**
 * 纯映射（可测）：entrySeqOf(representedThroughContextSeq) 的参考实现——
 * 在 contextSeq <= watermark 的单元中取 MAX(entry_seq)，跳过无 entry_seq
 * 的单元。与 ContextStore.maxEntrySeqAtOrBelowWatermark（SQL 聚合）语义一致。
 */
export function resolveEntrySeqForWatermark(
  units: ReadonlyArray<{ contextSeq: number; entrySeq?: number }>,
  representedThroughContextSeq: number,
): number | null {
  let max: number | null = null;
  for (const unit of units) {
    if (unit.contextSeq > representedThroughContextSeq) {
      continue;
    }
    if (unit.entrySeq === undefined) {
      continue;
    }
    if (max === null || unit.entrySeq > max) {
      max = unit.entrySeq;
    }
  }
  return max;
}

/** Adapter：把 ContextStore（context.db 权威 owner）适配为窄读取端口。 */
export function createContextHistoryReadPort(store: ContextStore): ContextHistoryReadPort {
  return {
    lineageId() {
      return store.lineageId;
    },
    getMaterializedBoundary(runtimeSessionId: string): MaterializedLineageBoundary {
      const lineage = store.getLineage(runtimeSessionId);
      if (lineage === undefined) {
        throw new Error(
          `context history read port: no lineage for ${runtimeSessionId} (fail closed)`,
        );
      }
      return {
        representedThroughContextSeq: lineage.representedThroughContextSeq,
        representedThroughEntrySeq: store.maxEntrySeqAtOrBelowWatermark(
          runtimeSessionId,
          lineage.representedThroughContextSeq,
        ),
        lineageStatus: deriveLineageStatus(lineage),
        providerProfileId: lineage.providerProfileId,
      };
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      // 只读 lineage 内闭区间统一 ContextUnit + sidecar；按 contextSeq 升序。
      const entries = store.listContextUnitsWithState(
        store.lineageId,
        afterContextSeqExclusive + 1,
        throughContextSeqInclusive,
      );
      const units = entries.map(toHistorianBatchUnit);
      const actualThrough =
        units.length === 0
          ? afterContextSeqExclusive
          : (units[units.length - 1]?.contextSeq ?? afterContextSeqExclusive);
      const fromContextSeq = afterContextSeqExclusive + 1;
      const semanticSchemaIds = [...new Set(units.map((member) => member.unit.contentSchemaId))];
      const estimatedTokens = units.reduce(
        (total, member) => total + estimateSemanticTokens(member.unit.content),
        0,
      );
      const frozenAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const batch: HistorianBatchV2 = {
        schemaId: "iris.historian_batch.v2",
        batchId: newBatchIdentity(store.lineageId, fromContextSeq, actualThrough),
        claimId: newClaimId(),
        contextLineageId: store.lineageId,
        fromContextSeq,
        throughContextSeq: actualThrough,
        rangeHash: "",
        semanticSchemaIds,
        units,
        estimatedTokens,
        frozenAt,
        leaseExpiresAt,
      };
      // 先确定实际端点再计算 hash（hash 覆盖真实窗口）。
      batch.rangeHash = historianBatchRangeHash(batch);
      return batch;
    },
    freezeBatch({ afterContextSeqExclusive, throughContextSeqInclusive, maxUnits, maxTokens }) {
      // freezeBatch 与 claimHistorianBatch 同一 Context 坐标批选择；显式
      // 重新冻结（新 claimId + 新 lease），并可选做 units/tokens 有界化提示。
      const claimed = store
        .listContextUnitsWithState(
          store.lineageId,
          afterContextSeqExclusive + 1,
          throughContextSeqInclusive,
        )
        .map(toHistorianBatchUnit);
      let units = claimed;
      if (maxUnits !== undefined && maxUnits > 0 && units.length > maxUnits) {
        units = units.slice(0, maxUnits);
      }
      if (maxTokens !== undefined && maxTokens > 0) {
        let tokens = 0;
        let cut = units.length;
        for (let index = 0; index < units.length; index += 1) {
          const member = units[index];
          if (member === undefined) {
            continue;
          }
          tokens += estimateSemanticTokens(member.unit.content);
          if (tokens > maxTokens) {
            cut = index;
            break;
          }
        }
        units = units.slice(0, cut);
      }
      const actualThrough =
        units.length === 0
          ? afterContextSeqExclusive
          : (units[units.length - 1]?.contextSeq ?? afterContextSeqExclusive);
      const fromContextSeq = afterContextSeqExclusive + 1;
      const semanticSchemaIds = [...new Set(units.map((member) => member.unit.contentSchemaId))];
      const estimatedTokens = units.reduce(
        (total, member) => total + estimateSemanticTokens(member.unit.content),
        0,
      );
      const frozenAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const batch: HistorianBatchV2 = {
        schemaId: "iris.historian_batch.v2",
        batchId: newBatchIdentity(store.lineageId, fromContextSeq, actualThrough),
        claimId: newClaimId(),
        contextLineageId: store.lineageId,
        fromContextSeq,
        throughContextSeq: actualThrough,
        rangeHash: "",
        semanticSchemaIds,
        units,
        estimatedTokens,
        frozenAt,
        leaseExpiresAt,
      };
      batch.rangeHash = historianBatchRangeHash(batch);
      return batch;
    },
  };
}

/**
 * 统一 ContextUnit + sidecar state → HistorianBatchUnit（batch 成员 = 同一个
 * ContextUnit + sidecar 坐标；sidecar 坐标绝不写回 Unit）。
 */
function toHistorianBatchUnit(entry: {
  unit: ContextUnit;
  state: import("./context-store.js").ContextUnitSidecarState;
}): HistorianBatchUnit {
  return {
    unit: entry.unit,
    contextSeq: entry.state.contextSeq,
    ...(entry.state.kind !== undefined ? { kind: entry.state.kind } : {}),
    historianDisposition: entry.state.historianDisposition,
    ...(entry.unit.derivation !== undefined ? { derivation: entry.unit.derivation } : {}),
    createdAt: entry.state.createdAt,
  };
}
