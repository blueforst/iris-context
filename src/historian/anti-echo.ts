/**
 * Historian anti-echo 纯函数层（Phase D，provider-neutral）。
 *
 * 权威来源：Notion v29 Evidence dispositions and anti-echo ——
 *   - 只有 disposition=include 且已进入 committed Historian batch 的
 *     ContextUnit 可以成为新 MemoryObservation 的 source basis；
 *   - reference_only 可以参与解释关系/目标，但不增加 evidence 计数/置信度；
 *   - exclude 不得进入分析 basis；
 *   - derived-only（assistant 语句完全派生自已有 memory/Compartment/work/
 *     source-unit 引用，没有新的 user/tool/external observation basis）必须
 *     标记为 derived-only，不得成为新 supporting evidence。
 *
 * 本模块是 PURE 层：无 I/O，确定性，输入为 values-only 的单元视图
 * （ContextHistoryReadPort 暴露的值，不持有 context.db 句柄）。输出
 * `EvidenceBasisRefV1`（contracts/memory-publication.ts 权威形状，含
 * contextLineageId/rawArchiveRef；disposition 不含 "retired"）。
 */

import type {
  HistorianDisposition,
  RuntimeEventKind,
  SemanticDerivationRefsV1,
} from "../contracts/context-unit.js";
import type { HistorianBatchUnit } from "../contracts/historian.js";
import type { EvidenceBasisRefV1 } from "../contracts/memory-publication.js";

/** Historian 消费的单元视图（ContextHistoryReadPort 暴露的 values-only 窄视图）。 */
export interface HistorianUnitView {
  contextUnitId: string;
  contextSeq: number;
  runtimeEventId: string;
  kind: RuntimeEventKind;
  historianDisposition: HistorianDisposition;
  contentHash: string;
  derivationRefs: SemanticDerivationRefsV1;
  /** raw archive 引用（attribution；缺失不影响 anti-echo 分类）。 */
  rawArchiveRef?: import("../contracts/context-unit.js").RawArchiveRefV1;
}

/**
 * 派生引用是否为"空"（没有任何 memory/compartment/work/source-unit 引用）。
 * 空派生引用 = 该单元有独立观察 basis（不可能是纯回显）。
 */
export function hasAnyDerivationRefs(refs: SemanticDerivationRefsV1): boolean {
  return (
    (refs.memoryRefs?.length ?? 0) > 0 ||
    (refs.compartmentIds?.length ?? 0) > 0 ||
    (refs.sourceContextMessageUnitIds?.length ?? 0) > 0 ||
    refs.workSnapshotVersion !== undefined
  );
}

/**
 * 判断单元是否为 derived-only（纯回显）。
 *
 * 规则：
 *  - 非 assistant 单元（user_input / tool_result）永远不是 derived-only ——
 *    user 输入和 tool 结果是新的外部观察 basis；
 *  - assistant 单元只有在完全派生自已有引用（memory/compartment/work/
 *    source-unit），且没有任何独立 basis 时才判定 derived-only。保守起见：
 *    只要存在任何 derivation refs 且单元不是 user/tool，即视为派生内容。
 */
export function isDerivedOnlyUnit(
  unit: Pick<HistorianUnitView, "kind" | "derivationRefs">,
): boolean {
  if (unit.kind === "user" || unit.kind === "tool_result") {
    return false;
  }
  return hasAnyDerivationRefs(unit.derivationRefs);
}

/** 单元能否成为新 MemoryObservation 的 evidence basis（include 且非 derived-only）。 */
export function isEvidenceEligibleUnit(unit: HistorianUnitView): boolean {
  if (unit.historianDisposition !== "include") {
    return false;
  }
  return !isDerivedOnlyUnit(unit);
}

/**
 * 从单元视图构建 EvidenceBasisRefV1（仅 eligible 单元调用）。
 * 返回 undefined 当单元不是 include 或为 derived-only（不进入 basis）。
 */
export function toEvidenceBasisRef(
  lineageId: string,
  unit: HistorianUnitView,
): EvidenceBasisRefV1 | undefined {
  if (unit.historianDisposition !== "include" || isDerivedOnlyUnit(unit)) {
    return undefined;
  }
  const ref: EvidenceBasisRefV1 = {
    schemaId: "iris.evidence_basis_ref.v1",
    contextLineageId: lineageId,
    contextUnitId: unit.contextUnitId,
    contextSeq: unit.contextSeq,
    runtimeEventId: unit.runtimeEventId,
    contentHash: unit.contentHash,
    historianDisposition: "include",
  };
  if (hasAnyDerivationRefs(unit.derivationRefs)) {
    ref.derivationRefs = unit.derivationRefs;
  }
  if (unit.rawArchiveRef !== undefined) {
    ref.rawArchiveRef = unit.rawArchiveRef;
  }
  return ref;
}

/**
 * 批量分类（供 compartment/observation authoring 使用）：输入本批单元的窄
 * 视图，输出 (evidenceBasis, derivedOnly) —— evidenceBasis 只含 eligible
 * 单元；derivedOnly=true 当本批没有产生任何新 evidence basis（整批是
 * 回显/重述）。
 *
 * 批级语义：assistant 单元若引用了**本批内的新单元**（derivationRefs.
 * sourceContextMessageUnitIds 与本批 include 且非 derived-only 的
 * input/tool_result 单元有交集），说明它是"基于新输入/新 tool 结果的回答"
 * 而非纯回显 —— 此时即使它携带 memory/compartment 派生引用，也不判
 * derived-only（避免误杀正常回答）。
 */
export function classifyEvidenceBasis(
  lineageId: string,
  units: HistorianUnitView[],
): { evidenceBasis: EvidenceBasisRefV1[]; derivedOnly: boolean } {
  const evidenceBasis: EvidenceBasisRefV1[] = [];
  const newObservationIds = new Set<string>();
  for (const unit of units) {
    if (unit.historianDisposition !== "include") {
      continue;
    }
    if (unit.kind === "user" || unit.kind === "tool_result") {
      if (!hasAnyDerivationRefs(unit.derivationRefs)) {
        newObservationIds.add(unit.contextUnitId);
      }
    }
  }
  for (const unit of units) {
    if (unit.historianDisposition !== "include") {
      continue;
    }
    const groundedInNewObservations =
      unit.kind === "assistant" &&
      (unit.derivationRefs.sourceContextMessageUnitIds ?? []).some((id) =>
        newObservationIds.has(id),
      );
    if (groundedInNewObservations) {
      evidenceBasis.push({
        schemaId: "iris.evidence_basis_ref.v1",
        contextLineageId: lineageId,
        contextUnitId: unit.contextUnitId,
        contextSeq: unit.contextSeq,
        runtimeEventId: unit.runtimeEventId,
        contentHash: unit.contentHash,
        historianDisposition: "include",
        ...(hasAnyDerivationRefs(unit.derivationRefs)
          ? { derivationRefs: unit.derivationRefs }
          : {}),
        ...(unit.rawArchiveRef !== undefined ? { rawArchiveRef: unit.rawArchiveRef } : {}),
      });
      continue;
    }
    if (isEvidenceEligibleUnit(unit)) {
      const ref = toEvidenceBasisRef(lineageId, unit);
      if (ref !== undefined) {
        evidenceBasis.push(ref);
      }
    }
  }
  return { evidenceBasis, derivedOnly: evidenceBasis.length === 0 };
}

/**
 * 从 HistorianBatchUnit（同一个 ContextUnit + sidecar 坐标）构造窄视图
 * （runner/authoring 使用）。runtimeEventId 在新模型下由 sourceRef 溯源：
 * DshMessageRef → `dsh:<sessionId>:<messageId>`；通用 source → sourceId。
 */
export function unitViewOf(lineageId: string, unit: HistorianBatchUnit): HistorianUnitView {
  const ref = unit.unit.sourceRef;
  const runtimeEventId =
    ref.schemaId === "iris.dsh_message_ref.v1"
      ? `dsh:${ref.sessionId}:${ref.messageId}`
      : ref.sourceId;
  return {
    contextUnitId: unit.unit.unitId,
    contextSeq: unit.contextSeq,
    runtimeEventId,
    kind: unit.kind ?? "operational",
    historianDisposition: unit.historianDisposition,
    contentHash: unit.unit.contentHash,
    derivationRefs: unit.derivation ?? { schemaId: "iris.semantic_derivation_refs.v1" },
    ...(unit.rawArchiveRef !== undefined ? { rawArchiveRef: unit.rawArchiveRef } : {}),
  };
}
