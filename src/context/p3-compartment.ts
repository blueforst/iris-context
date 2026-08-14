/**
 * P3 Compartment projection —— canonical BUST full rebuild 的 P3 层（Phase E）。
 *
 * 权威来源：Notion v27–v29 —— P3 = 当前连续叙事与历史语义的稳定 Compartment
 * 表示；BUST 后固定执行 full rebuild，读取最新 committed Compartments，令
 * P3 采用全部 eligible projections，并从 P5 Live Layer 移除已被 P3 安全表示
 * 的 live units。
 *
 * 每个 committed Compartment 投影为一个 P0P1P2P3P4Unit（buildContextGenerationV2
 * 的唯一 materializer 再将其包装为 ContextUnitV2）：
 *   - contextUnitId = compartmentId（lineage-scoped 稳定身份）；
 *   - source = { compartment, lineage, hash }（sourceId = compartmentId、
 *     sourceRevision = compartmentSequence、sourceHash = sourceRangeHash）；
 *   - semanticSchemaId = 'iris.semantic.compartment.v1'（generated registry，
 *     非 escape hatch）；
 *   - semanticContent = Compartment 的结构化摘要（content + OpenCode
 *     primary/secondary/decisions/openThreads + importance/episodeType）。
 *
 * Compartment 正文不复制进 context.db；本投影只消费 Historian 拥有的 VALUE。
 */

import type { JsonValue } from "../contracts/context-v27.js";
import { CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID } from "../contracts/context-v27.js";
import type { HistoricalCompartment } from "../historian/historian-compartment.js";
import type { P0P1P2P3P4Unit } from "./generation-builder.js";

/** P3 语义 schema id（generated registry 权威）。 */
export const COMPARTMENT_SEMANTIC_SCHEMA_ID = "iris.semantic.compartment.v1" as const;

/** P3 source schema id（committed CompartmentRevision 的 source 身份）。 */
export const COMPARTMENT_SOURCE_SCHEMA_ID = "iris.committed_compartment.v1" as const;

/** 把 committed Compartment 投影为 P0–P4 pre-projected unit（确定性）。 */
export function projectCommittedCompartment(compartment: HistoricalCompartment): P0P1P2P3P4Unit {
  return {
    contextUnitId: compartment.compartmentId,
    source: {
      schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
      sourceSchemaId: COMPARTMENT_SOURCE_SCHEMA_ID,
      sourceId: compartment.compartmentId,
      sourceRevision: String(compartment.compartmentSequence),
      sourceHash: compartment.sourceRangeHash,
    },
    semanticSchemaId: COMPARTMENT_SEMANTIC_SCHEMA_ID,
    semanticContent: compartmentSemanticContent(compartment),
  };
}

/**
 * Compartment 的结构化摘要（iris.semantic.compartment.v1）。
 * 只使用 HistoricalCompartment 的不可变 VALUE；字段映射与 schema
 * (contracts/source/schemas.json) 一一对应。
 */
export function compartmentSemanticContent(compartment: HistoricalCompartment): JsonValue {
  return {
    schemaId: COMPARTMENT_SEMANTIC_SCHEMA_ID,
    compartmentId: compartment.compartmentId,
    compartmentSequence: compartment.compartmentSequence,
    lineageId: compartment.lineageId,
    startContextSeq: compartment.startContextSeq,
    endContextSeq: compartment.endContextSeq,
    sourceRangeHash: compartment.sourceRangeHash,
    importance: compartment.importance,
    episodeType: compartment.episodeType,
    content: compartment.content,
    primarySummary: compartment.p1,
    secondarySummary: compartment.p2,
    decisions: compartment.p3,
    openThreads: compartment.p4,
  };
}
