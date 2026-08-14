/**
 * R3-P1 + v27–v29：ContextHistoryReadPort —— 跨库窄读取端口（Context lineage →
 * Historian）。
 *
 * 权威来源：Notion v27–v29 —— Historian 只通过 Context semantic history 消费
 * committed ContextMessageUnitV1（ContextHistoryReadPort），绝不消费 provider
 * wire / Session transcript。本端口只把 Context 坐标暴露为 VALUE（contextSeq、
 * content hash、状态字符串、JsonValue payload），绝不向消费方泄漏 context.db
 * 的句柄、Repository / ORM entity / 具体 Adapter，也不建立跨库外键。
 *
 * 跨库规则（AGENTS.md）：本端口是窄、版本化的契约；batch 形状以
 * src/contracts/historian.ts（权威 HistorianBatchV1）为准。
 */

import type {
  ContextMessageUnitV1,
  HistorianDisposition,
  RuntimeEventKind,
  SemanticDerivationRefsV1,
} from "../contracts/context-v27.js";

import {
  estimateSemanticTokens,
  historianBatchRangeHash,
  newBatchIdentity,
  newClaimId,
  type HistorianBatchV1,
} from "../contracts/historian.js";
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
   * 读取 lineage 内 [fromContextSeq, toContextSeq] 闭区间的
   * ContextMessageUnitV1 窄视图（values-only）。供 Historian 在构建 Evidence
   * 时做 anti-echo 分类；不泄漏 context.db 句柄。
   */
  listUnitsForHistorian(
    lineageId: string,
    fromContextSeq: number,
    toContextSeq: number,
  ): Array<{
    contextUnitId: string;
    contextSeq: number;
    runtimeEventId: string;
    kind: RuntimeEventKind;
    historianDisposition: HistorianDisposition;
    contentHash: string;
    derivationRefs: SemanticDerivationRefsV1;
  }>;

  /**
   * 读取 lineage 区间 WITH canonical provider-visible payloads（values-only
   * JsonValue —— 同一物化行，Context 提交的 canonical 语义内容）。仅供
   * publication envelope builder；anti-echo 视图保持 content-free。
   */
  listUnitsWithPayload(
    lineageId: string,
    fromContextSeq: number,
    toContextSeq: number,
  ): Array<{
    contextUnitId: string;
    contextSeq: number;
    runtimeEventId: string;
    kind: RuntimeEventKind;
    historianDisposition: HistorianDisposition;
    contentHash: string;
    derivationRefs: SemanticDerivationRefsV1;
    payload: ContextMessageUnitV1["semanticContent"];
    payloadTimestamp?: string;
  }>;

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
  }): HistorianBatchV1;

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
  }): HistorianBatchV1;
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

/** values-only derivation refs（anti-echo 层永不看到 undefined refs）。 */
function toSemanticDerivationRefs(
  refs: ContextMessageUnitV1["derivationRefs"],
): SemanticDerivationRefsV1 {
  if (refs === undefined) {
    return { schemaId: "iris.semantic_derivation_refs.v1" };
  }
  return {
    schemaId: "iris.semantic_derivation_refs.v1",
    ...(refs.memoryRefs !== undefined ? { memoryRefs: [...refs.memoryRefs] } : {}),
    ...(refs.compartmentIds !== undefined ? { compartmentIds: [...refs.compartmentIds] } : {}),
    ...(refs.workSnapshotVersion !== undefined
      ? { workSnapshotVersion: refs.workSnapshotVersion }
      : {}),
    ...(refs.sourceContextMessageUnitIds !== undefined
      ? { sourceContextMessageUnitIds: [...refs.sourceContextMessageUnitIds] }
      : {}),
  };
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
    listUnitsForHistorian(lineageId, fromContextSeq, toContextSeq) {
      return store.listUnitsByLineageRange(lineageId, fromContextSeq, toContextSeq).map((unit) => ({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        kind: unit.kind,
        historianDisposition: unit.historianDisposition,
        contentHash: unit.contentHash,
        derivationRefs: toSemanticDerivationRefs(unit.derivationRefs),
      }));
    },
    listUnitsWithPayload(lineageId, fromContextSeq, toContextSeq) {
      return store.listUnitsByLineageRange(lineageId, fromContextSeq, toContextSeq).map((unit) => ({
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        kind: unit.kind,
        historianDisposition: unit.historianDisposition,
        contentHash: unit.contentHash,
        derivationRefs: toSemanticDerivationRefs(unit.derivationRefs),
        payload: unit.semanticContent,
        payloadTimestamp: unit.createdAt,
      }));
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      // 只读 lineage 内闭区间单元；按 contextSeq 升序。
      const units = store.listUnitsByLineageRange(
        store.lineageId,
        afterContextSeqExclusive + 1,
        throughContextSeqInclusive,
      );
      const actualThrough =
        units.length === 0
          ? afterContextSeqExclusive
          : (units[units.length - 1]?.contextSeq ?? afterContextSeqExclusive);
      const fromContextSeq = afterContextSeqExclusive + 1;
      const semanticSchemaIds = [...new Set(units.map((unit) => unit.semanticSchemaId))];
      const estimatedTokens = units.reduce(
        (total, unit) => total + estimateSemanticTokens(unit.semanticContent),
        0,
      );
      const frozenAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const batch: HistorianBatchV1 = {
        schemaId: "iris.historian_batch.v1",
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
      const claimed = store.listUnitsByLineageRange(
        store.lineageId,
        afterContextSeqExclusive + 1,
        throughContextSeqInclusive,
      );
      let units = claimed;
      if (maxUnits !== undefined && maxUnits > 0 && units.length > maxUnits) {
        units = units.slice(0, maxUnits);
      }
      if (maxTokens !== undefined && maxTokens > 0) {
        let tokens = 0;
        let cut = units.length;
        for (let index = 0; index < units.length; index += 1) {
          const unit = units[index];
          if (unit === undefined) {
            continue;
          }
          tokens += estimateSemanticTokens(unit.semanticContent);
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
      const semanticSchemaIds = [...new Set(units.map((unit) => unit.semanticSchemaId))];
      const estimatedTokens = units.reduce(
        (total, unit) => total + estimateSemanticTokens(unit.semanticContent),
        0,
      );
      const frozenAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      const batch: HistorianBatchV1 = {
        schemaId: "iris.historian_batch.v1",
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
