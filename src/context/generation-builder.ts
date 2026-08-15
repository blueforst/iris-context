/**
 * Context Generation Builder —— 当前（single ContextUnit）generation 装配路径。
 *
 * 权威来源（iris-context#2 + #5，2026-08-15 Notion override）：
 *   - current Context container 的成员直接是 `ContextUnit[]`；P0–P5 只描述
 *     该数组上的六个连续逻辑区间（header.layerEnds）；
 *   - assembly 只选择/排序/引用既有 ContextUnit；**不执行** `ContextMessageUnit
 *     → ContextUnit` 的内容投影（旧双 DTO 投影已隔离到
 *     src/context/legacy/generation-builder-v2.ts）；
 *   - 类型名不带版本后缀：`ContextUnit` / `ContextGeneration`；wire/storage
 *     版本只由 schemaId 表达（生成式 `ContextUnitV3` / `ContextGenerationV3`
 *     是 wire/schema 实现细节）；
 *   - generation 仅驻内存、可从权威 source snapshot 确定性重建；validation
 *     fail-closed；hash basis 排除 hash 自身与 createdAt。
 *
 * Pipeline:
 *   freeze authoritative P0–P5 ContextUnit sources
 *   → 直接装配有序 ContextUnit[]
 *   → layerEnds（P0=[0,e0) … P5=[e4,e5)）
 *   → validation（含每 Unit 严格校验 + generation hash 重算）
 *   → atomic publish（in-memory；Provider Renderer 消费）
 */

import { createHash } from "node:crypto";

import type { ContextGenerationHeaderV1 } from "../../contracts/generated/types.js";
import {
  CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
  CONTEXT_GENERATION_V3_SCHEMA_ID,
  CONTEXT_UNIT_V3_SCHEMA_ID,
  validateContextUnitStrict,
  type ContextGeneration,
  type ContextUnit,
} from "../contracts/context-unit.js";

/**
 * 冻结源：P0–P5 六层直接为 ContextUnit[]（assembly 只选择/排序/引用既有
 * ContextUnit；不重新包装、不复制为第二 DTO）。
 */
export interface FrozenContextSources {
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
 * ContextGeneration 的 canonical generation hash：
 * 覆盖 schemaId + contextLineageId + sourceSnapshotHash + 有序 Unit
 * （unitId/contentSchemaId/contentHash）+ layerEnds；排除 hash 自身与 createdAt。
 * 相同 frozen source snapshot 的等价 rebuild 产生相同 hash。
 */
export function computeContextGenerationHash(input: {
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
 * 严格校验一个 ContextGeneration（当前容器，wire schema = context_generation.v3）：
 *  - schemaId/header 正确；layerEnds 单调非递减且 e5 === units.length；
 *  - 每个 Unit 经 validateContextUnitStrict（含 canonical hash 重算）；
 *  - generation 内 unitId 唯一（同一 source 只解析为一个 ContextUnit；
 *    identity 塌缩 → fail-closed）；
 *  - contextGenerationHash 重算一致。
 */
export function validateContextGeneration(generation: unknown): {
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
      return { valid: false, reason: `unit[${i}] must be a ContextUnit v3 (wire)` };
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
  const contextLineageId = header["contextLineageId"];
  if (typeof contextLineageId !== "string" || contextLineageId.length === 0) {
    return { valid: false, reason: "header.contextLineageId must be a non-empty string" };
  }
  const sourceSnapshotHash = header["sourceSnapshotHash"];
  if (typeof sourceSnapshotHash !== "string" || sourceSnapshotHash.length === 0) {
    return { valid: false, reason: "header.sourceSnapshotHash must be a non-empty string" };
  }
  const typed = generation as ContextGeneration;
  const expectedGenHash = computeContextGenerationHash({
    schemaId: CONTEXT_GENERATION_V3_SCHEMA_ID,
    contextLineageId,
    sourceSnapshotHash,
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
 * 从冻结的 P0–P5 ContextUnit[] 构建验证过的当前 ContextGeneration。
 * 层边界 = 固定 P0→P5 顺序的有序数组 index；Unit 不保存 layer。
 * 任一校验失败 → 抛错（fail-closed）。
 */
export function buildContextGeneration(
  sources: FrozenContextSources,
  contextGenerationId: string,
  createdAt: string,
): ContextGeneration {
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

  const contextGenerationHash = computeContextGenerationHash({
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

  const generation: ContextGeneration = {
    schemaId: CONTEXT_GENERATION_V3_SCHEMA_ID,
    header,
    // 领域 ContextUnit（sourceRef 窄化为判别联合）→ 生成式 wire 视图
    // （wire 单元 sourceRef 为宽松对象；运行期是同一 JSON 对象）。
    units: units as unknown as ContextGeneration["units"],
  };
  const check = validateContextGeneration(generation);
  if (!check.valid) {
    throw new Error(
      `buildContextGeneration: validation failed: ${check.reason ?? ""} (fail-closed)`,
    );
  }
  return generation;
}

/** 从 generation 提取指定 P-level 的 ContextUnit[]（index 只是当前 frame 位置）。 */
export function unitsInLayer(
  generation: ContextGeneration,
  layer: 0 | 1 | 2 | 3 | 4 | 5,
): readonly ContextUnit[] {
  const ends = generation.header.layerEnds;
  const start = layer === 0 ? 0 : (ends[layer - 1] ?? 0);
  const end = ends[layer] ?? ends[5];
  return generation.units.slice(start, end) as unknown as readonly ContextUnit[];
}
