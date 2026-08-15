/**
 * P3 Compartment projection —— canonical BUST full rebuild 的 P3 层（Phase E +
 * iris-context#2 单 ContextUnit 迁移）。
 *
 * 权威来源（Notion v27–v29 + 2026-08-15 override）：
 *   - P3 = 当前连续叙事与历史语义的稳定 Compartment 表示；
 *   - Historian 产生 Compartment source，Context 接纳后物化为**新的**
 *     ContextUnit C1（通过 immutable basis refs 引用被表示的旧 Units）；
 *     不是把旧 Unit 改造成 CompartmentUnit；
 *   - 本 projector 只产出中性 AdmissionCandidate；Context admission（唯一
 *     materializer）负责创建 ContextUnit。
 *
 * 每个 committed Compartment 投影为一个 AdmissionCandidate：
 *   - sourceRef = { sourceSchemaId: 'iris.committed_compartment.v1',
 *     sourceId: compartmentId, sourceRevision: compartmentSequence,
 *     sourceHash: sourceRangeHash }；
 *   - contentSchemaId = 'iris.semantic.compartment.v1'（generated registry）；
 *   - content = Compartment 的结构化摘要；
 *   - derivation.sourceContextMessageUnitIds = 被表示的旧 Unit ids（由 BUST
 *     提供 —— 覆盖的 runtime-origin 单元）。
 *
 * Compartment 正文不复制进 context.db（P3 内容由 Historian store 权威持有）；
 * ContextUnit 只在当前 generation 中按确定性 identity 材料化。
 */

import type { JsonValue } from "../contracts/context-unit.js";
import type { AdmissionCandidate } from "./context-admission.js";
import type { HistoricalCompartment } from "../historian/historian-compartment.js";

/** P3 语义 schema id（generated registry 权威）。 */
export const COMPARTMENT_SEMANTIC_SCHEMA_ID = "iris.semantic.compartment.v1" as const;

/** P3 source schema id（committed CompartmentRevision 的 source 身份）。 */
export const COMPARTMENT_SOURCE_SCHEMA_ID = "iris.committed_compartment.v1" as const;

/**
 * 把 committed Compartment 投影为中性 AdmissionCandidate（确定性；Context
 * admission 随后 materialize 为 ContextUnit）。
 *
 * @param coveredUnitIds 该 Compartment 覆盖的旧 Unit ids（immutable basis；
 *   由 BUST 从 covered runtime-origin 单元推导）。缺省 = 无 basis。
 */
export function projectCommittedCompartmentCandidate(
  compartment: HistoricalCompartment,
  coveredUnitIds?: readonly string[],
): AdmissionCandidate {
  return {
    sourceRef: {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: COMPARTMENT_SOURCE_SCHEMA_ID,
      sourceId: compartment.compartmentId,
      sourceRevision: String(compartment.compartmentSequence),
      sourceHash: compartment.sourceRangeHash,
    },
    contentSchemaId: COMPARTMENT_SEMANTIC_SCHEMA_ID,
    content: compartmentSemanticContent(compartment),
    ...(coveredUnitIds !== undefined && coveredUnitIds.length > 0
      ? {
          derivation: {
            schemaId: "iris.semantic_derivation_refs.v1",
            sourceContextMessageUnitIds: [...coveredUnitIds],
          },
        }
      : {}),
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
