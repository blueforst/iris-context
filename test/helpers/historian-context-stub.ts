/**
 * Phase D test helper: ContextHistoryReadPort stub —— 从可变的
 * HistorianBatchUnit[] fixture 提供 claim/freeze/list 视图。
 *
 * 权威边界（v29 + Feature 5）：Historian 的唯一正常语义输入是 Context 冻结的
 * HistorianBatchV2（lineage + 全局 contextSeq；units 成员为同一个
 * ContextUnit + sidecar 坐标）。本 stub 模拟 ContextHistoryReadPort 的 VALUE
 * 视图（不持有 context.db）。
 */
import {
  estimateSemanticTokens,
  historianBatchRangeHash,
  newBatchIdentity,
  newClaimId,
  type HistorianBatchUnit,
  type HistorianBatchV2,
} from "../../src/contracts/historian.js";
import type { ContextMessageUnitV1 } from "../../src/contracts/context-v27.js";
import type { ContextHistoryReadPort } from "../../src/context/history-read-port.js";
import type { SemanticDerivationRefsV1 } from "../../src/contracts/context-v27.js";

export const STUB_LINEAGE_ID = "identity-stub";

export function emptyDerivationRefs(): SemanticDerivationRefsV1 {
  return { schemaId: "iris.semantic_derivation_refs.v1" };
}

/**
 * 构造一条 fixture HistorianBatchUnit（同一个 ContextUnit + sidecar 坐标，按
 * 全局 contextSeq 升序提供）。input 沿用旧 ContextMessageUnitV1 字段名：
 * semanticContent/contextUnitId/semanticSchemaId/contentHash 映射到
 * `unit.unit` 的 content/unitId/contentSchemaId/contentHash；kind 只保留
 * user/assistant/tool_result，其他 kind（如 operational）映射为 undefined；
 * sourceRef 使用通用 `iris.context_unit_source_ref.v1`；derivationRefs→derivation。
 */
export function fixtureUnit(input: {
  contextSeq: number;
  kind: ContextMessageUnitV1["kind"];
  semanticSchemaId: string;
  semanticContent: ContextMessageUnitV1["semanticContent"];
  historianDisposition?: ContextMessageUnitV1["historianDisposition"];
  derivationRefs?: SemanticDerivationRefsV1;
  rawArchiveRef?: ContextMessageUnitV1["rawArchiveRef"];
  contextUnitId?: string;
  createdAt?: string;
}): HistorianBatchUnit {
  const contextUnitId = input.contextUnitId ?? `unit-${input.contextSeq}`;
  const contentHash = `hash-${input.contextSeq}`;
  const kind =
    input.kind === "user" || input.kind === "assistant" || input.kind === "tool_result"
      ? input.kind
      : undefined;
  return {
    unit: {
      schemaId: "iris.context_unit.v3",
      unitId: contextUnitId,
      contextId: STUB_LINEAGE_ID,
      contentSchemaId: input.semanticSchemaId,
      content: input.semanticContent,
      contentHash,
      sourceRef: {
        schemaId: "iris.context_unit_source_ref.v1",
        sourceSchemaId: input.semanticSchemaId,
        sourceId: contextUnitId,
        sourceHash: contentHash,
      },
      ...(input.derivationRefs !== undefined ? { derivation: input.derivationRefs } : {}),
    },
    contextSeq: input.contextSeq,
    ...(kind !== undefined ? { kind } : {}),
    historianDisposition: input.historianDisposition ?? "include",
    ...(input.derivationRefs !== undefined ? { derivation: input.derivationRefs } : {}),
    ...(input.rawArchiveRef !== undefined ? { rawArchiveRef: input.rawArchiveRef } : {}),
    createdAt:
      input.createdAt ?? new Date(Date.UTC(2026, 7, 1, 0, 0, input.contextSeq)).toISOString(),
  };
}

/** 常用 fixture：user + assistant（无派生引用）→ 非 derived-only。 */
export function simpleUnits(count = 3): HistorianBatchUnit[] {
  const units: HistorianBatchUnit[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    units.push(
      fixtureUnit({
        contextSeq: seq,
        kind: seq % 2 === 1 ? "user" : "assistant",
        semanticSchemaId:
          seq % 2 === 1
            ? "iris.semantic.context_message.user.v1"
            : "iris.semantic.context_message.assistant.v1",
        semanticContent: {
          role: seq % 2 === 1 ? "user" : "assistant",
          content: `message ${seq}`,
        },
      }),
    );
  }
  return units;
}

/**
 * 构建一个 ContextHistoryReadPort stub，从 fixture units 提供
 * claimHistorianBatch / freezeBatch（lineage + 全局 contextSeq）。
 */
export function createFixtureHistoryPort(options: {
  units?: () => HistorianBatchUnit[];
  representedThroughContextSeq?: number;
  lineageId?: string;
}): ContextHistoryReadPort {
  const units = options.units ?? (() => []);
  const lineageId = options.lineageId ?? STUB_LINEAGE_ID;
  const claim = (
    afterContextSeqExclusive: number,
    throughContextSeqInclusive: number,
  ): HistorianBatchV2 => {
    const claimed = units().filter(
      (unit) =>
        unit.contextSeq > afterContextSeqExclusive && unit.contextSeq <= throughContextSeqInclusive,
    );
    const actualThrough =
      claimed.length === 0
        ? afterContextSeqExclusive
        : (claimed[claimed.length - 1]?.contextSeq ?? afterContextSeqExclusive);
    const fromContextSeq = afterContextSeqExclusive + 1;
    const batch: HistorianBatchV2 = {
      schemaId: "iris.historian_batch.v2",
      batchId: newBatchIdentity(lineageId, fromContextSeq, actualThrough),
      claimId: newClaimId(),
      contextLineageId: lineageId,
      fromContextSeq,
      throughContextSeq: actualThrough,
      rangeHash: "",
      semanticSchemaIds: [...new Set(claimed.map((unit) => unit.unit.contentSchemaId))],
      units: claimed,
      estimatedTokens: claimed.reduce(
        (total, unit) => total + estimateSemanticTokens(unit.unit.content),
        0,
      ),
      frozenAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    batch.rangeHash = historianBatchRangeHash(batch);
    return batch;
  };
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: options.representedThroughContextSeq ?? 0,
        representedThroughEntrySeq: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    lineageId() {
      return lineageId;
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      return claim(afterContextSeqExclusive, throughContextSeqInclusive);
    },
    freezeBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      return claim(afterContextSeqExclusive, throughContextSeqInclusive);
    },
  };
}
