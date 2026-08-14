/**
 * Context Generation Builder — v27 V2 generation pipeline.
 *
 * This is the ONLY path that assembles a validated ContextGenerationV2 from
 * authoritative P0–P5 sources. The legacy invocation-snapshot / message-
 * transform flow is NOT part of the normal generation path.
 *
 * Pipeline:
 *   freeze authoritative P0–P5 sources
 *   → deterministic ContextUnitV2[] projection
 *   → ContextGenerationV2.header.layerEnds
 *   → validation
 *   → atomic publish (in-memory; Provider Renderer consumes)
 *
 * ContextGenerationV2 is in-memory only, rebuildable from durable sources.
 */

import { createHash } from "node:crypto";

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
} from "../contracts/context-v27.js";
import { type ContextGenerationV3, type ContextUnitV3 } from "../../contracts/generated/types.js";
import {
  CONTEXT_GENERATION_V3_SCHEMA_ID,
  CONTEXT_UNIT_V3_SCHEMA_ID,
  validateContextUnitStrict,
  type ContextUnit,
} from "../contracts/context-unit.js";

/**
 * Semantic schema IDs for P5 unit projection.
 * Removed P5_SEMANTIC_SCHEMA_MAP: per #103, the generation builder MUST reuse
 * the durable unit's semanticSchemaId 1:1, not re-derive it via a second mapper.
 * The durable unit already carries semanticSchemaId from KIND_TO_SEMANTIC_SCHEMA_ID.
 */

/**
 * Input to the Context Generation Builder: the frozen P0–P5 sources.
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
 * owners; the generation builder wraps them as ContextUnitV2.
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

// ---------------------------------------------------------------------------
// Feature 3（iris-context#2）：ContextGenerationV3 —— current Context 直接
// 包含 ContextUnit[]（同一 ContextUnit 贯穿；无 ContextMessageUnit → ContextUnit
// 投影）。
// ---------------------------------------------------------------------------

/**
 * v3 冻结源：P0–P5 六层直接为 ContextUnit[]（assembly 只选择/排序/引用既有
 * ContextUnit；不重新包装、不复制为第二 DTO）。
 */
export interface FrozenContextSourcesV3 {
  /** lineage identity。 */
  contextLineageId: string;
  /** 冻结 source snapshot hash（确定性，覆盖全部 P0–P5 source）。 */
  sourceSnapshotHash: string;
  p0Units: readonly ContextUnit[];
  p1Units: readonly ContextUnit[];
  p2Units: readonly ContextUnit[];
  p3Units: readonly ContextUnit[];
  p4Units: readonly ContextUnit[];
  p5Units: readonly ContextUnit[];
}

/**
 * ContextGenerationV3 的 canonical generation hash（v3 basis）：
 * 覆盖 schemaId + contextLineageId + sourceSnapshotHash + 有序 Unit
 * （unitId/contentSchemaId/contentHash）+ layerEnds；排除 hash 自身与 createdAt。
 * 相同 frozen source snapshot 的等价 rebuild 产生相同 hash。
 */
export function computeContextGenerationHashV3(input: {
  schemaId: string;
  contextLineageId: string;
  sourceSnapshotHash: string;
  units: readonly ContextUnit[];
  layerEnds: readonly [number, number, number, number, number, number];
}): string {
  const hash = createHash("sha256");
  hash.update(input.schemaId, "utf8");
  hash.update("\0");
  hash.update(input.contextLineageId, "utf8");
  hash.update("\0");
  hash.update(input.sourceSnapshotHash, "utf8");
  hash.update("\0");
  for (const unit of input.units) {
    hash.update(unit.unitId, "utf8");
    hash.update("\0");
    hash.update(unit.contentSchemaId, "utf8");
    hash.update("\0");
    hash.update(unit.contentHash, "utf8");
    hash.update("\0");
  }
  hash.update(input.layerEnds.join(","), "utf8");
  return hash.digest("hex");
}

/**
 * 严格校验一个 ContextGenerationV3：
 *  - schemaId/header 正确；layerEnds 单调非递减且 e5 === units.length；
 *  - 每个 Unit 经 validateContextUnitStrict（含 canonical hash 重算）；
 *  - contextGenerationHash 重算一致。
 */
export function validateContextGenerationV3(generation: unknown): {
  valid: boolean;
  reason?: string;
} {
  if (typeof generation !== "object" || generation === null) {
    return { valid: false, reason: "generation is not an object" };
  }
  const gen = generation as Record<string, unknown>;
  if (gen["schemaId"] !== CONTEXT_GENERATION_V3_SCHEMA_ID) {
    return { valid: false, reason: `unknown generation schemaId: ${String(gen["schemaId"])}` };
  }
  const header = gen["header"] as Record<string, unknown> | null;
  if (header === null || typeof header !== "object") {
    return { valid: false, reason: "missing or invalid generation header" };
  }
  if (header["schemaId"] !== CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID) {
    return { valid: false, reason: "unknown generation header schemaId" };
  }
  const layerEnds = header["layerEnds"];
  if (!Array.isArray(layerEnds) || layerEnds.length !== 6) {
    return { valid: false, reason: "layerEnds must be an array of 6 numbers" };
  }
  const ends = layerEnds as number[];
  for (let i = 0; i < 6; i += 1) {
    const value = ends[i];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return { valid: false, reason: "layerEnds must contain non-negative integers" };
    }
    if (i > 0 && (ends[i - 1] ?? 0) > value) {
      return { valid: false, reason: "layerEnds must be non-decreasing" };
    }
  }
  const units = gen["units"];
  if (!Array.isArray(units)) {
    return { valid: false, reason: "units must be an array" };
  }
  const unitList = units as unknown[];
  if (ends[5] !== unitList.length) {
    return {
      valid: false,
      reason: `layerEnds[5] (${ends[5]}) must equal units.length (${unitList.length})`,
    };
  }
  for (let i = 0; i < unitList.length; i += 1) {
    const unit = unitList[i];
    if (
      unit === null ||
      typeof unit !== "object" ||
      (unit as { schemaId?: unknown }).schemaId !== CONTEXT_UNIT_V3_SCHEMA_ID
    ) {
      return { valid: false, reason: `unit[${i}] must be a ContextUnit v3` };
    }
    const unitCheck = validateContextUnitStrict(unit);
    if (!unitCheck.valid) {
      return { valid: false, reason: `unit[${i}]: ${unitCheck.reason ?? ""}` };
    }
  }
  // single ContextUnit 不变量：generation 内 unitId 必须唯一（同一 source 只
  // 能解析为一个 ContextUnit；重复 unitId = identity 塌缩 → fail-closed）。
  const seenUnitIds = new Set<string>();
  for (const unit of unitList as Array<{ unitId?: unknown }>) {
    const unitId = unit.unitId;
    if (typeof unitId !== "string" || unitId.length === 0) {
      return { valid: false, reason: "unit carries a missing unitId" };
    }
    if (seenUnitIds.has(unitId)) {
      return { valid: false, reason: `duplicate unitId in generation: ${unitId}` };
    }
    seenUnitIds.add(unitId);
  }
  const typed = generation as ContextGenerationV3;
  const expectedGenHash = computeContextGenerationHashV3({
    schemaId: CONTEXT_GENERATION_V3_SCHEMA_ID,
    contextLineageId: header["contextLineageId"] as string,
    sourceSnapshotHash: header["sourceSnapshotHash"] as string,
    units: typed.units as unknown as readonly ContextUnit[],
    layerEnds: ends as [number, number, number, number, number, number],
  });
  if (header["contextGenerationHash"] !== expectedGenHash) {
    return {
      valid: false,
      reason: `contextGenerationHash mismatch (expected ${expectedGenHash}, got ${header["contextGenerationHash"]})`,
    };
  }
  return { valid: true };
}

/**
 * 从冻结的 P0–P5 ContextUnit[] 构建验证过的 ContextGenerationV3。
 * 层边界 = 固定 P0→P5 顺序的有序数组 index；Unit 不保存 layer。
 * 任一校验失败 → 抛错（fail-closed）。
 */
export function buildContextGenerationV3(
  sources: FrozenContextSourcesV3,
  contextGenerationId: string,
  createdAt: string,
): ContextGenerationV3 {
  const units: ContextUnit[] = [
    ...sources.p0Units,
    ...sources.p1Units,
    ...sources.p2Units,
    ...sources.p3Units,
    ...sources.p4Units,
    ...sources.p5Units,
  ];
  const e0 = sources.p0Units.length;
  const e1 = e0 + sources.p1Units.length;
  const e2 = e1 + sources.p2Units.length;
  const e3 = e2 + sources.p3Units.length;
  const e4 = e3 + sources.p4Units.length;
  const e5 = units.length;
  const layerEnds: readonly [number, number, number, number, number, number] = [
    e0,
    e1,
    e2,
    e3,
    e4,
    e5,
  ];

  const contextGenerationHash = computeContextGenerationHashV3({
    schemaId: CONTEXT_GENERATION_V3_SCHEMA_ID,
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

  const generation: ContextGenerationV3 = {
    schemaId: CONTEXT_GENERATION_V3_SCHEMA_ID,
    header,
    // 领域 ContextUnit（sourceRef 窄化为判别联合）→ 生成式 wire 视图
    // （ContextUnitV3.sourceRef 为宽松对象；运行期是同一 JSON 对象）。
    units: units as unknown as readonly ContextUnitV3[],
  };
  const check = validateContextGenerationV3(generation);
  if (!check.valid) {
    throw new Error(
      `buildContextGenerationV3: validation failed: ${check.reason ?? ""} (fail-closed)`,
    );
  }
  return generation;
}

/** 从 generation 提取指定 P-level 的 ContextUnit[]（index 只是当前 frame 位置）。 */
export function unitsInLayerV3(
  generation: ContextGenerationV3,
  layer: 0 | 1 | 2 | 3 | 4 | 5,
): readonly ContextUnit[] {
  const ends = generation.header.layerEnds;
  const start = layer === 0 ? 0 : (ends[layer - 1] ?? 0);
  const end = ends[layer] ?? ends[5];
  return generation.units.slice(start, end) as unknown as readonly ContextUnit[];
}
