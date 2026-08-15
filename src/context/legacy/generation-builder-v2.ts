/**
 * LEGACY —— v27 V2 generation pipeline（iris-context#5 legacy 隔离）。
 *
 * ⚠️ 本模块是显式 legacy/compatibility 边界：旧双 DTO 路径
 * （ContextMessageUnitV1 → ContextUnitV2 投影、P0P1P2P3P4Unit pre-projection、
 * ContextGenerationV2）只为 migration fixtures / 历史测试 / 兼容读取保留。
 * 正常生产路径（src/context/** 当前域）不得导入本模块；legacy-dual-dto-fence
 * 敏感度门只 allowlist 本模块与旧 contracts shim。
 *
 * 当前领域模型（single ContextUnit lifecycle，iris-context#2）不实现
 * `ContextMessageUnit → ContextUnit` 的内容投影 —— generation-builder.ts
 * 当前路径直接装配 ContextUnit[]（assembly 只选择/排序/引用既有 ContextUnit）。
 *
 * 保留内容（原 generation-builder.ts V2 部分，语义不改）：
 *   - FrozenContextSources（V2 冻结源，p5Units 为 ContextMessageUnitV1）；
 *   - P0P1P2P3P4Unit（旧 P0–P4 pre-projected unit 形状）；
 *   - buildContextGenerationV2 / projectStaticUnit / projectP5Unit；
 *   - unitLayer / unitsInLayer（V2 generation 层提取）。
 */

import {
  type ContextGenerationV2,
  type ContextGenerationHeaderV1,
  type ContextMessageUnitV1,
  type ContextUnitV2,
  type ContextUnitHeaderV1,
  type ContextUnitSourceRefV1,
  type JsonValue,
  CONTEXT_GENERATION_V2_SCHEMA_ID,
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_V2_SCHEMA_ID,
  CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  validateGenerationV2,
  validateGenerationV2Strict,
  computeContextGenerationHash,
  computeSemanticContentHash,
  computeContextMessageUnitContentHashV1,
} from "../../contracts/context-v27.js";

/**
 * Input to the V2 Context Generation Builder: the frozen P0–P5 sources.
 * Each layer contributes zero or more ContextUnitV2 members to the ordered
 * units array. layerEnds records the boundaries.
 *
 * P0 System, P1 Persona, P2 Capability, P3 Compartment, P4 Memory are
 * provided as pre-projected units by their respective owners.
 * P5 durable source is committed ContextMessageUnitV1, projected 1:1.
 */
export interface FrozenContextSources {
  /** The lineage identity for this generation. */
  contextLineageId: string;
  /** Hash of the frozen source snapshot (deterministic, covers all P0-P4 sources). */
  sourceSnapshotHash: string;
  /** P0 system units (typically 0 or 1). */
  p0Units: readonly P0P1P2P3P4Unit[];
  /** P1 persona units (typically 0 or 1). */
  p1Units: readonly P0P1P2P3P4Unit[];
  /** P2 capability/declaration units. */
  p2Units: readonly P0P1P2P3P4Unit[];
  /** P3 compartment units. */
  p3Units: readonly P0P1P2P3P4Unit[];
  /** P4 memory units. */
  p4Units: readonly P0P1P2P3P4Unit[];
  /** P5 durable ContextMessageUnits (selected live units for this generation). */
  p5Units: readonly ContextMessageUnitV1[];
}

/**
 * A pre-projected unit from P0–P4 sources (system, persona, capability,
 * compartment, memory). These are already canonicalized by their source
 * owners; the V2 generation builder wraps them as ContextUnitV2.
 *
 * LEGACY：正常路径不再使用本形状 —— 当前 source owner / projector 提供中性
 * AdmissionCandidate（src/context/context-admission.ts）。
 */
export interface P0P1P2P3P4Unit {
  /** Stable identity within the lineage. */
  readonly contextUnitId: string;
  /** Source reference for provenance. */
  readonly source: ContextUnitSourceRefV1;
  /** Semantic schema discriminator. */
  readonly semanticSchemaId: string;
  /** Semantic payload (JsonValue). */
  readonly semanticContent: JsonValue;
}

/**
 * Build a validated ContextGenerationV2 from frozen authoritative P0–P5 sources.
 *
 * The generation is in-memory, deterministic, and rebuildable. Provider
 * Renderer consumes only the validated result.
 *
 * Throws if validation fails (fail-closed).
 *
 * LEGACY：仅供 migration fixtures / 历史测试 / 兼容读取。
 */
export function buildContextGenerationV2(
  sources: FrozenContextSources,
  contextGenerationId: string,
  createdAt: string,
): ContextGenerationV2 {
  const units: ContextUnitV2[] = [];

  // Project P0–P4 pre-projected units into the ordered array
  for (const p0 of sources.p0Units) {
    units.push(projectStaticUnit(p0));
  }
  const e0 = units.length;

  for (const p1 of sources.p1Units) {
    units.push(projectStaticUnit(p1));
  }
  const e1 = units.length;

  for (const p2 of sources.p2Units) {
    units.push(projectStaticUnit(p2));
  }
  const e2 = units.length;

  for (const p3 of sources.p3Units) {
    units.push(projectStaticUnit(p3));
  }
  const e3 = units.length;

  for (const p4 of sources.p4Units) {
    units.push(projectStaticUnit(p4));
  }
  const e4 = units.length;

  // Project P5 durable ContextMessageUnits 1:1 into the generation array
  for (const cmu of sources.p5Units) {
    units.push(projectP5Unit(cmu));
  }
  const e5 = units.length;

  const layerEnds: readonly [number, number, number, number, number, number] = [
    e0,
    e1,
    e2,
    e3,
    e4,
    e5,
  ];

  const contextGenerationHash = computeContextGenerationHash({
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    contextLineageId: sources.contextLineageId,
    sourceSnapshotHash: sources.sourceSnapshotHash,
    units,
    layerEnds,
  });

  const header: ContextGenerationHeaderV1 = {
    schemaId: CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
    contextGenerationId,
    contextLineageId: sources.contextLineageId,
    sourceSnapshotHash: sources.sourceSnapshotHash,
    layerEnds,
    contextGenerationHash,
    createdAt,
  };

  const generation: ContextGenerationV2 = {
    schemaId: CONTEXT_GENERATION_V2_SCHEMA_ID,
    header,
    units,
  };

  if (!validateGenerationV2(generation)) {
    throw new Error(
      "buildContextGenerationV2: generated ContextGenerationV2 failed validation (fail-closed)",
    );
  }

  // Feature B (#104): also run the strict validator with hash recompute
  const strictCheck = validateGenerationV2Strict(generation);
  if (!strictCheck.valid) {
    throw new Error(`buildContextGenerationV2: strict validation failed: ${strictCheck.reason}`);
  }

  return generation;
}

/**
 * Project a P0–P4 pre-projected unit into a ContextUnitV2.
 */
function projectStaticUnit(unit: P0P1P2P3P4Unit): ContextUnitV2 {
  const header: ContextUnitHeaderV1 = {
    schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
    contextUnitId: unit.contextUnitId,
    source: unit.source,
    semanticSchemaId: unit.semanticSchemaId,
    contentHash: computeSemanticContentHash(unit.semanticContent),
  };
  return {
    schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
    header,
    semanticContent: unit.semanticContent,
  };
}

/**
 * Project a P5 durable ContextMessageUnit into a generation-level ContextUnitV2.
 *
 * Per #103: reuses the durable unit's contextUnitId, semanticSchemaId, and
 * contentHash 1:1 — no second mapper or schema re-derivation.
 *
 * LEGACY：正常路径没有 `ContextMessageUnit → ContextUnit` 投影 —— 当前 P5
 * 直接选择 store 中同一个 ContextUnit。
 */
function projectP5Unit(cmu: ContextMessageUnitV1): ContextUnitV2 {
  // Feature A (#110): the durable unit's semanticContent IS the canonical
  // JsonValue payload plane — projected 1:1, no re-serialization.
  const semanticContent = cmu.semanticContent;

  // A7 (#117): source-bound P5 validation — recompute the durable contentHash
  // from the actual semanticContent + kind + disposition + derivationRefs +
  // semanticSchemaId and verify it matches the durable unit's stored
  // contentHash. This detects semantic tampering at the projection boundary:
  // if semanticContent was mutated (e.g. by DB corruption or concurrent
  // modification) but contentHash was not updated, the recomputation will
  // differ and the projection fails closed.
  const recomputedHash = computeContextMessageUnitContentHashV1({
    semanticSchemaId: cmu.semanticSchemaId,
    kind: cmu.kind,
    historianDisposition: cmu.historianDisposition,
    derivationRefs: cmu.derivationRefs ?? { schemaId: "iris.semantic_derivation_refs.v1" },
    semanticContent,
  });
  if (recomputedHash !== cmu.contentHash) {
    throw new Error(
      `projectP5Unit: durable contentHash mismatch for unit ${cmu.contextUnitId} ` +
        `(stored ${cmu.contentHash}, recomputed ${recomputedHash}) — ` +
        `semanticContent was tampered or corrupted (fail closed)`,
    );
  }

  const header: ContextUnitHeaderV1 = {
    schemaId: CONTEXT_UNIT_HEADER_V1_SCHEMA_ID,
    contextUnitId: cmu.contextUnitId,
    source: {
      schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
      sourceSchemaId: "iris.context_message_unit.v1",
      sourceId: cmu.contextUnitId,
      sourceHash: cmu.contentHash,
    },
    // Reuse the durable unit's semanticSchemaId 1:1 — no second mapper
    semanticSchemaId: cmu.semanticSchemaId,
    contentHash: cmu.contentHash,
  };

  return {
    schemaId: CONTEXT_UNIT_V2_SCHEMA_ID,
    header,
    semanticContent,
  };
}

/**
 * Extract the P-level membership for a unit from the generation.
 * Returns null if the index is outside the valid range.
 */
export function unitLayer(
  generation: ContextGenerationV2,
  index: number,
): 0 | 1 | 2 | 3 | 4 | 5 | null {
  const ends = generation.header.layerEnds;
  const e0 = ends[0] ?? -1;
  const e1 = ends[1] ?? -1;
  const e2 = ends[2] ?? -1;
  const e3 = ends[3] ?? -1;
  const e4 = ends[4] ?? -1;
  const e5 = ends[5] ?? -1;
  if (index < 0 || index >= e5) return null;
  if (index < e0) return 0;
  if (index < e1) return 1;
  if (index < e2) return 2;
  if (index < e3) return 3;
  if (index < e4) return 4;
  return 5;
}

/**
 * Get all units belonging to a specific P-level layer.
 */
export function unitsInLayer(
  generation: ContextGenerationV2,
  layer: 0 | 1 | 2 | 3 | 4 | 5,
): readonly ContextUnitV2[] {
  const ends = generation.header.layerEnds;
  const start = layer === 0 ? 0 : (ends[layer - 1] ?? 0);
  const end = ends[layer] ?? ends[5];
  return generation.units.slice(start, end);
}
