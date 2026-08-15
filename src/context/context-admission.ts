/**
 * Context Admission —— Context 接纳边界（iris-context#2，single ContextUnit
 * lifecycle）。
 *
 * 权威来源（2026-08-15 Notion override + iris-context#2）：
 *   - semantic source → Context admission → ContextUnit exactly once；
 *     从接纳直到离开 Context 生命周期，identity 与领域类型保持不变；
 *   - `content` = Context 接纳时确定的 provider-neutral canonical content，
 *     生命周期内不可原地修改；语义变化 → 新的 ContextUnit；
 *   - runtime-origin Unit 的 sourceRef 是 DshMessageRef；P0–P4 / 派生 Unit 用
 *     通用 ContextUnitSourceRefV1；
 *   - unitId 由 contextId + sourceRef 确定性派生（source 未变化 → 同一逻辑
 *     Unit；rebuild 不产生随机新 identity）；
 *   - 本模块是材料化的唯一入口：P0–P2 contributor、P3/P4 projector、DSH
 *     adapter 都经它创建 ContextUnit（不重新包装、不复制为第二 DTO）。
 *
 * 本模块不拥有持久化细节 —— 持久化由 ContextStore.admitContextUnit（context.db
 * 唯一 owner）完成；admission 负责校验、派生、materialize 与 ordering 分配。
 */

import {
  CONTEXT_UNIT_V3_SCHEMA_ID,
  computeContextUnitContentHash,
  deriveContextUnitId,
  isDshMessageRef,
  validateContextUnitStrict,
  type ContextUnit,
  type ContextUnitSourceRef,
  type DshMessageRef,
} from "../contracts/context-unit.js";
import { KIND_TO_SEMANTIC_SCHEMA_ID } from "../contracts/context-unit.js";

/** runtime-origin user 消息的语义 schema（anti-echo 判别目标）。 */
const USER_MESSAGE_SEMANTIC_SCHEMA_ID = KIND_TO_SEMANTIC_SCHEMA_ID.user;
import { validateSemanticContent } from "../../contracts/generated/validators.js";
import type { JsonValue, SemanticDerivationRefsV1 } from "../contracts/context-unit.js";
import type { ContextStore } from "./context-store.js";

/** 接纳输入：source identity + 语义类型 + canonical content。 */
export interface AdmitSourceInput {
  /** immutable source identity（DshMessageRef 或通用 ContextUnitSourceRefV1）。 */
  sourceRef: ContextUnitSourceRef;
  /** 语义类型判别器（iris.semantic.*；unknown → fail-closed）。 */
  contentSchemaId: string;
  /** canonical content（Context 接纳时确定的 provider-neutral 规范内容）。 */
  content: JsonValue;
  /** immutable basis refs（仅派生 Unit；运行时消息无 derivation）。 */
  derivation?: SemanticDerivationRefsV1;
  /**
   * P5 runtime-origin：Session binding 校验（未知/过期 Session fail-closed）。
   * 缺省 = lineage-direct（派生/非 runtime 路径）。
   */
  runtimeSessionId?: string;
  /**
   * exactly-once 锚（source_event_id）。缺省按 sourceRef 派生
   * （dsh:<sessionId>:<messageId> 或 <sourceSchemaId>:<sourceId>）。
   */
  sourceAnchor?: string;
  /**
   * runtime-origin user 消息的 source 判别（DSH MessageSource.kind 的中性投影；
   * anti-echo 纵深防御，iris-context#2 §4）。
   *
   * DSH `user/message` 的 `source.kind` 只有 `user`（真人直接输入）才是真实
   * experience；plugin 注入的 context（instructions/catalog/snapshot/notice/
   * relay/recall）、goal continuation、synthetic recall 等**不得**成为真实
   * experience Unit。runtime adapter 应先过滤；本 admission 对显式声明为非
   * user 来源的 user-role 内容 fail-closed 拒绝（防 adapter 漏判/误传）。
   *
   * 缺省 = 未声明（允许；adapter 负责过滤 —— 兼容既有调用方）。
   */
  runtimeSourceKind?: "user" | "plugin" | "model" | "tool" | "other";
}

/**
 * AdmissionCandidate —— source owner / projector 提供给 Context admission 的
 * 中性候选（P0–P2 contributor、P3 Compartment、P4 Recollection 都返回这个
 * 形状；Context 是唯一 materialize 方）。
 */
export interface AdmissionCandidate {
  /** immutable source identity。 */
  sourceRef: ContextUnitSourceRef;
  /** 语义类型判别器。 */
  contentSchemaId: string;
  /** canonical content。 */
  content: JsonValue;
  /** immutable basis refs（仅派生候选）。 */
  derivation?: SemanticDerivationRefsV1;
}

/** DshMessageRef 的默认 exactly-once 锚。 */
export function dshSourceAnchor(ref: DshMessageRef): string {
  return `dsh:${ref.sessionId}:${ref.messageId}`;
}

/** 通用 sourceRef 的默认 exactly-once 锚。 */
export function genericSourceAnchor(
  ref: Extract<ContextUnitSourceRef, { schemaId: "iris.context_unit_source_ref.v1" }>,
): string {
  return `${ref.sourceSchemaId}:${ref.sourceId}`;
}

/** sourceRef → exactly-once 锚（未显式提供时）。 */
export function sourceAnchorOf(sourceRef: ContextUnitSourceRef): string {
  if (isDshMessageRef(sourceRef)) {
    return dshSourceAnchor(sourceRef);
  }
  return genericSourceAnchor(sourceRef);
}

/**
 * 材料化一个统一 ContextUnit（纯函数；exactly-once 由调用方/store 的
 * UNIQUE(context_lineage_id, unit_id) 保证）。
 *  - contentSchemaId 必须命中生成式语义 registry 且 content 通过校验；
 *  - unitId = deriveContextUnitId(contextId, sourceRef)（确定性）；
 *  - contentHash = computeContextUnitContentHash（canonical v3 basis）；
 *  - 严格校验（含 hash 重算）。
 */
export function materializeContextUnit(contextId: string, input: AdmitSourceInput): ContextUnit {
  const semanticCheck = validateSemanticContent(input.contentSchemaId, input.content);
  if (!semanticCheck.valid) {
    throw new Error(
      `context admission: content for schema ${input.contentSchemaId} failed validation: ` +
        `${semanticCheck.errors?.join("; ") ?? "invalid"} (fail closed)`,
    );
  }
  // anti-echo 纵深防御（iris-context#2 §4）：runtime-origin user 消息若被显式
  // 声明为非 "user" 来源（plugin 注入 context / recall / notice / relay /
  // instructions / goal continuation 等合成内容）→ fail-closed 拒绝，绝不把
  // 合成上下文当成真人 experience。assistant/tool_result 的来源天然是
  // model/tool，不受此限制；未声明来源由 adapter 负责过滤。
  if (
    input.contentSchemaId === USER_MESSAGE_SEMANTIC_SCHEMA_ID &&
    input.runtimeSourceKind !== undefined &&
    input.runtimeSourceKind !== "user"
  ) {
    throw new Error(
      `context admission: runtime user-role message with source kind ` +
        `${JSON.stringify(input.runtimeSourceKind)} cannot be admitted as a real experience ` +
        "(plugin-injected context / recall / notice must not become a ContextUnit; fail closed)",
    );
  }
  const unitId = deriveContextUnitId(contextId, input.sourceRef);
  const unit: ContextUnit = {
    schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
    unitId,
    contextId,
    contentSchemaId: input.contentSchemaId,
    content: input.content,
    contentHash: computeContextUnitContentHash({
      schemaId: CONTEXT_UNIT_V3_SCHEMA_ID,
      unitId,
      contextId,
      contentSchemaId: input.contentSchemaId,
      content: input.content,
      sourceRef: input.sourceRef,
      ...(input.derivation !== undefined ? { derivation: input.derivation } : {}),
    }),
    sourceRef: input.sourceRef,
    ...(input.derivation !== undefined ? { derivation: input.derivation } : {}),
  };
  const check = validateContextUnitStrict(unit);
  if (!check.valid) {
    throw new Error(
      `context admission: materialized unit failed strict validation: ${check.reason ?? ""} (fail closed)`,
    );
  }
  return unit;
}

/**
 * ContextAdmission —— 接纳边界服务。材料化 ContextUnit 并持久化
 * （ContextStore.admitContextUnit；exactly-once）。同一 source 幂等返回既有
 * Unit；语义变化（新 content）→ 新的 ContextUnit（同 sourceRef 冲突则
 * fail-closed）。
 */
export class ContextAdmission {
  constructor(private readonly store: ContextStore) {}

  /**
   * 接纳一个 source 为统一 ContextUnit 并持久化（P5 runtime-origin 主路径）。
   * contextSeq = context_units MAX + 1（accepted ordering；同一 lineage 单调）。
   */
  admit(input: AdmitSourceInput): ContextUnit {
    const unit = materializeContextUnit(this.store.lineageId, input);
    const contextSeq = this.store.maxContextSeqByLineage(this.store.lineageId) + 1;
    const anchor = input.sourceAnchor ?? sourceAnchorOf(input.sourceRef);
    return this.store.admitContextUnit({
      unit,
      contextSeq,
      sourceAnchor: anchor,
      ...(input.runtimeSessionId !== undefined ? { runtimeSessionId: input.runtimeSessionId } : {}),
    });
  }
}
