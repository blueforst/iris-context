/**
 * ContextUnit —— Context 内唯一的内容领域类型（iris-context#2，DSH Context
 * vertical slice 的单类型生命周期迁移）。
 *
 * 权威来源（2026-08-15 Notion override + iris-context#2）：
 *   - 任何内容一旦被 Context 接纳，物化为 `ContextUnit` exactly once；从接纳
 *     直到离开 Context 生命周期，identity 与领域类型保持不变；
 *   - 类型名不带 `V1/V2`；wire/storage 版本只由 `schemaId` 表达。旧历史已使用
 *     `iris.context_unit.v1` / `iris.context_unit.v2`，因此新统一 ContextUnit
 *     分配新 schema 身份 `iris.context_unit.v3`；
 *   - Unit 本体只保存从接纳到退出生命周期都不变化的身份、语义与来源；
 *     `content` = Context 接纳时确定的 provider-neutral canonical content，
 *     生命周期内不可原地修改；语义变化 → 新的 ContextUnit；
 *   - runtime-origin Unit 的 sourceRef 是 `DshMessageRef`
 *     （sessionId + messageId + optional eventSeq）；Unit 同时保存 canonical
 *     content，绝不退化为 DSH lazy pointer；
 *   - 可变的 lifecycle/ordering/选择/表示状态位于 Unit 外部的 sidecar/index/
 *     binding 记录，不得复制 canonical content。
 *
 * 本文件是领域层契约 shim：`ContextUnit`/`ContextUnitSourceRef`/`DshMessageRef`
 * 等无版本类型名基于 contracts/generated（单一机器权威）重新导出并加窄，
 * 同时提供非 schema-domain 逻辑（严格校验、canonical hash、确定性 unitId
 * 派生）。禁止在其他生产文件手写重复 interface。
 */

import { createHash } from "node:crypto";

import type {
  ContextUnitV3,
  ContextGenerationV3,
  ContextUnitSourceRefV1,
  DshMessageRefV1,
  PiArchiveEntryRefV1,
  DshAttachmentRefV1,
  JsonValue,
  SemanticDerivationRefsV1,
} from "../../contracts/generated/types.js";
import {
  IRIS_CONTEXT_UNIT_V3_SCHEMA_ID,
  IRIS_DSH_MESSAGE_REF_V1_SCHEMA_ID,
  IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  IRIS_PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID,
  IRIS_DSH_ATTACHMENT_REF_V1_SCHEMA_ID,
  IRIS_SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  IRIS_CONTEXT_GENERATION_V3_SCHEMA_ID,
  IRIS_CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID,
} from "../../contracts/generated/types.js";
import {
  validate_iris_dsh_message_ref_v1,
  validate_iris_context_unit_source_ref_v1,
  validate_iris_pi_archive_entry_ref_v1,
  validate_iris_dsh_attachment_ref_v1,
  validate_iris_semantic_derivation_refs_v1,
  validateSemanticContent,
} from "../../contracts/generated/validators.js";

// ---------------------------------------------------------------------------
// 领域类型名（无版本后缀）；wire 版本只由 schemaId 表达
// ---------------------------------------------------------------------------

export type {
  JsonValue,
  JsonPrimitive,
  HistorianDisposition,
  RuntimeEventKind,
  ContextMessageUnitLifecycleState,
  RawArchiveRefV1,
} from "../../contracts/generated/types.js";
export { KIND_TO_SEMANTIC_SCHEMA_ID } from "../../contracts/generated/types.js";
export { IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID as CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID } from "../../contracts/generated/types.js";
export { IRIS_CONTEXT_UNIT_V3_SCHEMA_ID as CONTEXT_UNIT_V3_SCHEMA_ID };
export { IRIS_DSH_MESSAGE_REF_V1_SCHEMA_ID as DSH_MESSAGE_REF_V1_SCHEMA_ID };
export { IRIS_PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID as PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID };
export { IRIS_DSH_ATTACHMENT_REF_V1_SCHEMA_ID as DSH_ATTACHMENT_REF_V1_SCHEMA_ID };
export { IRIS_CONTEXT_GENERATION_V3_SCHEMA_ID as CONTEXT_GENERATION_V3_SCHEMA_ID };
export { IRIS_CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID as CONTEXT_GENERATION_HEADER_V1_SCHEMA_ID };

/** `ContextUnit` —— Context 唯一内容领域类型（= 生成式 `ContextUnitV3` + sourceRef 窄化）。 */
export type ContextUnit = Omit<ContextUnitV3, "sourceRef"> & {
  readonly sourceRef: ContextUnitSourceRef;
};

/**
 * `ContextGeneration` —— 无版本 current Context container 领域别名
 * （iris-context#5）。当前容器成员直接为 `ContextUnit[]`，P0–P5 是数组上的
 * 六个连续逻辑区间（header.layerEnds）。wire/storage 版本由 schemaId 表达；
 * 生成式 `ContextGenerationV3` 是 wire/schema 实现细节，正常公共领域代码使用
 * 本无版本名称。
 */
export type ContextGeneration = ContextGenerationV3;

/** 生成式 `ContextUnitV3`（wire/storage 形状，单一机器权威）。 */
export type { ContextUnitV3 };

/**
 * `ContextUnitSourceRef` —— immutable source identity 判别联合：
 *  - `ContextUnitSourceRefV1`（通用 source：sourceSchemaId/sourceId/
 *    sourceRevision?/sourceHash）—— P0–P4 / 派生 Unit；
 *  - `DshMessageRefV1`（runtime-origin P5：sessionId/messageId/eventSeq?/
 *    sourceHash?）—— DSH Session 中对应 message 的稳定唯一引用；
 *  - `PiArchiveEntryRefV1`（Pi compatibility runtime-origin：runtimeSessionId/
 *    entryId/entrySeq?/sourceHash）—— Pi archive entry 的专用判别引用
 *    （iris_agent#130 A2）。稳定 identity = runtimeSessionId + entryId；
 *    `entrySeq` 是 archive-local locator（可保存/恢复扫描，不进入语义
 *    revision、不进入稳定 identity）。raw provenance 查找只依赖本持久化
 *    sourceRef 即可定位原 Pi runtime/archive，不依赖当前 Session binding。
 */
export type ContextUnitSourceRef = ContextUnitSourceRefV1 | DshMessageRefV1 | PiArchiveEntryRefV1;

/** `DshMessageRef` —— runtime-origin Unit 的原始事实来源引用。 */
export type DshMessageRef = DshMessageRefV1;

/** `PiArchiveEntryRef` —— Pi archive entry 的专用判别 source 引用。 */
export type PiArchiveEntryRef = PiArchiveEntryRefV1;

/** `DshAttachmentRef` —— DSH durable attachment 的 typed reference（A3）。 */
export type DshAttachmentRef = DshAttachmentRefV1;

export { IRIS_SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID as SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID };
export type { SemanticDerivationRefsV1 };

// ---------------------------------------------------------------------------
// 判别守卫 / 严格解析（fail-closed）
// ---------------------------------------------------------------------------

/** 类型守卫：是否 DshMessageRef（runtime-origin source）。 */
export function isDshMessageRef(value: unknown): value is DshMessageRefV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["schemaId"] !== IRIS_DSH_MESSAGE_REF_V1_SCHEMA_ID) {
    return false;
  }
  if (typeof record["sessionId"] !== "string" || (record["sessionId"] as string).length === 0) {
    return false;
  }
  if (typeof record["messageId"] !== "string" || (record["messageId"] as string).length === 0) {
    return false;
  }
  return true;
}

/** 类型守卫：是否通用 ContextUnitSourceRefV1（非 runtime-origin）。 */
export function isGenericSourceRef(value: unknown): value is ContextUnitSourceRefV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["schemaId"] !== IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID) {
    return false;
  }
  if (
    typeof record["sourceSchemaId"] !== "string" ||
    (record["sourceSchemaId"] as string).length === 0
  ) {
    return false;
  }
  if (typeof record["sourceId"] !== "string" || (record["sourceId"] as string).length === 0) {
    return false;
  }
  if (typeof record["sourceHash"] !== "string" || (record["sourceHash"] as string).length === 0) {
    return false;
  }
  return true;
}

/** 类型守卫：是否 PiArchiveEntryRef（Pi compatibility runtime-origin source）。 */
export function isPiArchiveEntryRef(value: unknown): value is PiArchiveEntryRefV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["schemaId"] !== IRIS_PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID) {
    return false;
  }
  if (
    typeof record["runtimeSessionId"] !== "string" ||
    (record["runtimeSessionId"] as string).length === 0
  ) {
    return false;
  }
  if (typeof record["entryId"] !== "string" || (record["entryId"] as string).length === 0) {
    return false;
  }
  if (typeof record["sourceHash"] !== "string" || (record["sourceHash"] as string).length === 0) {
    return false;
  }
  return true;
}

/**
 * 严格解析 `ContextUnitSourceRef`（fail-closed）：既不是 DshMessageRef、
 * PiArchiveEntryRef 也不是通用 source ref → 抛错；形状合法但未通过生成式
 * 机器权威 schema 校验（未知键、可选字段类型错误）→ 同样抛错。这是 Unit
 * 反序列化/校验的唯一合法入口。
 */
export function parseContextUnitSourceRef(value: unknown): ContextUnitSourceRef {
  if (isDshMessageRef(value)) {
    const check = validate_iris_dsh_message_ref_v1(value);
    if (!check.valid) {
      throw new Error(
        `context unit: DshMessageRef failed generated schema validation: ` +
          `${check.errors?.join("; ") ?? "invalid"} (fail closed)`,
      );
    }
    return value;
  }
  if (isPiArchiveEntryRef(value)) {
    const check = validate_iris_pi_archive_entry_ref_v1(value);
    if (!check.valid) {
      throw new Error(
        `context unit: PiArchiveEntryRef failed generated schema validation: ` +
          `${check.errors?.join("; ") ?? "invalid"} (fail closed)`,
      );
    }
    return value;
  }
  if (isGenericSourceRef(value)) {
    const check = validate_iris_context_unit_source_ref_v1(value);
    if (!check.valid) {
      throw new Error(
        `context unit: ContextUnitSourceRefV1 failed generated schema validation: ` +
          `${check.errors?.join("; ") ?? "invalid"} (fail closed)`,
      );
    }
    return value;
  }
  throw new Error(
    `context unit: sourceRef must be a DshMessageRefV1, PiArchiveEntryRefV1 or ` +
      `ContextUnitSourceRefV1, got ${JSON.stringify(value)} (fail closed)`,
  );
}

/**
 * 严格解析 DSH typed attachment ref（`iris.dsh_attachment_ref.v1`；A3）。
 * 未知 schemaId / 畸形形状 → 抛错（fail-closed）。渲染器/Provider 边界用它
 * 把 canonical image part 的 `attachmentRef` 收窄为类型化引用 —— opaque
 * attachmentId 绝不作为图片 data。
 */
export function parseDshAttachmentRef(value: unknown): DshAttachmentRefV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`context unit: attachmentRef is not an object (fail closed)`);
  }
  const record = value as Record<string, unknown>;
  if (record["schemaId"] !== IRIS_DSH_ATTACHMENT_REF_V1_SCHEMA_ID) {
    throw new Error(
      `context unit: attachmentRef has unknown schemaId ${JSON.stringify(record["schemaId"])} (fail closed)`,
    );
  }
  const check = validate_iris_dsh_attachment_ref_v1(value);
  if (!check.valid) {
    throw new Error(
      `context unit: DshAttachmentRef failed generated schema validation: ` +
        `${check.errors?.join("; ") ?? "invalid"} (fail closed)`,
    );
  }
  return value as DshAttachmentRefV1;
}

// ---------------------------------------------------------------------------
// canonical content hash
// ---------------------------------------------------------------------------

/** canonical JSON（键排序 + 紧凑序列化；确定性）。 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, JsonValue>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] ?? null)}`);
  return `{${pairs.join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 版本化 canonical content hash basis（v3）。 */
export const CONTEXT_UNIT_CONTENT_HASH_BASIS_VERSION = "iris.context_unit.content_hash.v3" as const;

/**
 * `ContextUnit.contentHash` —— 覆盖 Unit 全部 immutable 字段（schemaId/unitId/
 * contextId/contentSchemaId/content/sourceRef/derivation?）的 canonical hash。
 * 同一 Unit 内容必须产生同一 hash（跨 crash/restart 可重放）；任何 hash-basis
 * 字段变化都会产生不同 hash（tamper 检测 basis）。
 *
 * DshMessageRef 的 `eventSeq` 是 Session-local archive locator（不是语义
 * identity/content），因此**不进入** contentHash basis —— 同一条消息无论
 * eventSeq 定位值如何都解析为同一 canonical content（且与 unitId 派生一致：
 * unitId 也不含 eventSeq）。
 */
export function computeContextUnitContentHash(input: {
  schemaId: string;
  unitId: string;
  contextId: string;
  contentSchemaId: string;
  content: JsonValue;
  sourceRef: ContextUnitSourceRef;
  derivation?: SemanticDerivationRefsV1;
}): string {
  const normalizedSourceRef: ContextUnitSourceRef = isDshMessageRef(input.sourceRef)
    ? (({ sessionId, messageId, sourceHash, schemaId }) =>
        ({
          schemaId,
          sessionId,
          messageId,
          ...(sourceHash !== undefined ? { sourceHash } : {}),
        }) as DshMessageRefV1)(input.sourceRef)
    : isPiArchiveEntryRef(input.sourceRef)
      ? (({ runtimeSessionId, entryId, sourceHash, schemaId }) =>
          ({
            schemaId,
            runtimeSessionId,
            entryId,
            sourceHash,
          }) as PiArchiveEntryRefV1)(input.sourceRef)
      : input.sourceRef;
  return sha256(
    canonicalJson({
      basis: CONTEXT_UNIT_CONTENT_HASH_BASIS_VERSION,
      schemaId: input.schemaId,
      unitId: input.unitId,
      contextId: input.contextId,
      contentSchemaId: input.contentSchemaId,
      content: input.content,
      sourceRef: normalizedSourceRef as unknown as JsonValue,
      ...(input.derivation !== undefined
        ? { derivation: input.derivation as unknown as JsonValue }
        : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// 确定性 unitId 派生 与 exactly-once 锚（单一版本化 canonical identity）
// ---------------------------------------------------------------------------

/**
 * 版本化 canonical identity encoder（iris-context#2 + #4 hardening，A1）。
 *
 * 背景：旧实现用 `|` / `:` 拼接 source 字段派生 unitId 与 exactly-once 锚，
 * 而任意 source 字段（sessionId/sourceId/revision/…）都可能包含这些字符，
 * 存在**确定性**序列化碰撞（例如 sourceId="a|b" + revision=undefined 与
 * sourceId="a" + revision="b" 撞同一 unitId）。本模块用 canonical JSON 数组
 * （长度由 JSON 语法保证、无分隔符歧义）编码全部 identity 字段，根除该类碰撞。
 *
 * 字段分类（单一事实来源，unitId 与 anchor 共享同一套规则，禁止复制）：
 *   - type discriminator（ref 类型判别符 —— 防跨类型 identity 碰撞，review
 *     minor-1）：DshMessageRef / PiArchiveEntryRef / 通用 ref 的 schemaId 进入
 *     identity，杜绝「某 DSH sessionId+messageId 恰好等于某 Pi
 *     runtimeSessionId+entryId」时的确定性合并/碰撞；
 *   - stable identity fields（对同一 source 永不变化，构成逻辑 identity）：
 *       DshMessageRef         → sessionId + messageId
 *       PiArchiveEntryRefV1   → runtimeSessionId + entryId（A2）
 *       ContextUnitSourceRefV1 → sourceSchemaId + sourceId
 *   - semantic revision fields（语义修订；变化 → 新的 ContextUnit）：
 *       ContextUnitSourceRefV1 → sourceRevision? + sourceHash
 *   - locator-only fields（archive-local 定位；**绝不**进入稳定 identity /
 *       unitId / anchor）：
 *       DshMessageRef.eventSeq；PiArchiveEntryRefV1.entrySeq（A2）
 *
 * 版本字符串进入 hash basis：未来改变编码/字段集合时 bump 版本，避免新旧
 * 派生静默混用。v3：加入 type discriminator（schemaId）。
 */
export const SOURCE_IDENTITY_ENCODING_VERSION = "iris.source_identity.v3" as const;

/** 归一化的 identity 字段（type discriminator + stable + semantic revision；locator 排除）。 */
export function sourceIdentityFields(sourceRef: ContextUnitSourceRef): (string | null)[] {
  if (isDshMessageRef(sourceRef)) {
    return [IRIS_DSH_MESSAGE_REF_V1_SCHEMA_ID, sourceRef.sessionId, sourceRef.messageId];
  }
  if (isPiArchiveEntryRef(sourceRef)) {
    return [IRIS_PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID, sourceRef.runtimeSessionId, sourceRef.entryId];
  }
  return [
    IRIS_CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
    sourceRef.sourceSchemaId,
    sourceRef.sourceId,
    sourceRef.sourceRevision ?? null,
    sourceRef.sourceHash,
  ];
}

/** 版本化 identity key（unitId 与 anchor 的公共 hash basis 前缀；无歧义）。 */
export function sourceIdentityBasis(sourceRef: ContextUnitSourceRef): string {
  return canonicalJson([SOURCE_IDENTITY_ENCODING_VERSION, ...sourceIdentityFields(sourceRef)]);
}

/**
 * 确定性 unitId 派生（admission 用）。同一 contextId + 同一 sourceRef 必须
 * 产生同一 unitId（source 未变化 → 解析为同一逻辑 Unit；rebuild 不产生随机
 * 新 identity）。contextId 进入 basis：unitId 在 contextId 内唯一且跨 lineage
 * 不碰撞。
 *
 * 64-bit 截断审计（A1）：保持 `unit-<16 hex>` 长度不变（64 bit SHA-256 前缀）
 * —— 既有 durable Unit identity 不得静默改变。碰撞风险：同 lineage 内两个
 * 不同 source 撞同一 unitId 的概率 ~2^-64；`UNIQUE(context_lineage_id, unit_id)`
 * 索引使碰撞在 INSERT 时 fail-closed（可检测，不静默）。编码歧义（`|`/`:`）
 * 已由 canonical JSON 根除；截断级碰撞风险保留为已审计的可接受项。未来若要
 * 加长 ID，必须新增 forward-only migration + compatibility lookup，不得静默
 * 改变既有 identity。
 */
export function deriveContextUnitId(contextId: string, sourceRef: ContextUnitSourceRef): string {
  const basis = canonicalJson([
    SOURCE_IDENTITY_ENCODING_VERSION,
    contextId,
    ...sourceIdentityFields(sourceRef),
  ]);
  return `unit-${sha256(basis).slice(0, 16)}`;
}

/**
 * 默认 exactly-once 锚（source_event_id）。与 unitId 共享同一 identity 字段
 * 规则（sourceIdentityFields），但只对 sourceRef 本身取 hash（不含 contextId：
 * 锚是全局 source 去重键，现有 UNIQUE(source_event_id) 语义保持）。96-bit
 * 截断；碰撞由 UNIQUE 索引 fail-closed。
 */
export function sourceAnchorOf(sourceRef: ContextUnitSourceRef): string {
  return `src-${sha256(sourceIdentityBasis(sourceRef)).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// 严格校验（fail-closed）
// ---------------------------------------------------------------------------

/**
 * 严格校验一个 `ContextUnit`（v3）：
 *  - schemaId 必须是 `iris.context_unit.v3`；
 *  - 必填字段非空；
 *  - sourceRef 必须可解析为 DshMessageRefV1 或 ContextUnitSourceRefV1；
 *  - contentSchemaId 必须命中生成式语义 registry，且 content 通过对应语义
 *    schema 校验（unknown schema fail-closed，无 escape hatch）；
 *  - contentHash 必须等于按 canonical basis 重算的值（tamper 检测）。
 *
 * 返回 `{ valid: true }` 或 `{ valid: false, reason }`。抛错语义由调用方决定；
 * 本函数保持纯函数（不抛，除非 sourceRef 解析失败 —— 见 parseContextUnitSourceRef）。
 */
export function validateContextUnitStrict(unit: unknown): {
  valid: boolean;
  reason?: string;
} {
  if (typeof unit !== "object" || unit === null) {
    return { valid: false, reason: "unit is not an object" };
  }
  const record = unit as Record<string, unknown>;
  if (record["schemaId"] !== IRIS_CONTEXT_UNIT_V3_SCHEMA_ID) {
    return {
      valid: false,
      reason: `unknown unit schemaId: ${JSON.stringify(record["schemaId"])} (expected ${IRIS_CONTEXT_UNIT_V3_SCHEMA_ID})`,
    };
  }
  const knownKeys = new Set([
    "schemaId",
    "unitId",
    "contextId",
    "contentSchemaId",
    "content",
    "contentHash",
    "sourceRef",
    "derivation",
  ]);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      return {
        valid: false,
        reason: `unit carries unknown key ${JSON.stringify(key)} (header/payload separation: lifecycle/ordering/representation state lives in sidecars, not the unit)`,
      };
    }
  }
  for (const field of ["unitId", "contextId", "contentSchemaId", "contentHash"]) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return { valid: false, reason: `${field} must be a non-empty string` };
    }
  }
  if (record["content"] === undefined) {
    return { valid: false, reason: "content is required (canonical content)" };
  }
  let sourceRef: ContextUnitSourceRef;
  try {
    sourceRef = parseContextUnitSourceRef(record["sourceRef"]);
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "invalid sourceRef",
    };
  }
  const contentSchemaId = record["contentSchemaId"] as string;
  const content = record["content"] as JsonValue;
  const semanticCheck = validateSemanticContent(contentSchemaId, content);
  if (!semanticCheck.valid) {
    return {
      valid: false,
      reason: `semantic validation failed: ${semanticCheck.errors?.join("; ") ?? "unknown"}`,
    };
  }
  let derivation: SemanticDerivationRefsV1 | undefined;
  if (record["derivation"] !== undefined) {
    const derivationCheck = validateDerivationRefs(record["derivation"]);
    if (!derivationCheck.valid) {
      return { valid: false, reason: `derivation is invalid: ${derivationCheck.reason}` };
    }
    derivation = record["derivation"] as SemanticDerivationRefsV1;
  }
  const expectedHash = computeContextUnitContentHash({
    schemaId: IRIS_CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId: record["unitId"] as string,
    contextId: record["contextId"] as string,
    contentSchemaId,
    content,
    sourceRef,
    ...(derivation !== undefined ? { derivation } : {}),
  });
  if (record["contentHash"] !== expectedHash) {
    return {
      valid: false,
      reason: `contentHash mismatch (expected ${expectedHash}, got ${record["contentHash"]})`,
    };
  }
  return { valid: true };
}

/** 派生 refs 的形状校验（immutable basis 才有资格进 Unit；fail-closed）。 */
function validateDerivationRefs(value: unknown): { valid: boolean; reason?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "derivation must be an object" };
  }
  const check = validate_iris_semantic_derivation_refs_v1(value);
  if (!check.valid) {
    return {
      valid: false,
      reason: check.errors?.join("; ") ?? "derivation failed generated schema validation",
    };
  }
  return { valid: true };
}
