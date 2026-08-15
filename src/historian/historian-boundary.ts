/**
 * Historian boundary（Phase D，contextSeq 坐标）—— lineage 物化边界 clamp。
 *
 * v29：Context 在 freezeBatch 中冻结完整 semantic boundary；Historian 不得
 * 扩大 batch range。本模块只提供纯的**物化边界 clamp**：Context lineage 的
 * 物化 watermark（representedThroughContextSeq）是 Context 侧"已表示"的上界
 * （对应旧 m0-clamp 语义，但以 contextSeq 表达，不再使用 m0/m1 措辞）。
 *
 * 当 lineage 尚未物化到批上界时，eligibleThroughContextSeq 被 clamp 到
 * 物化 watermark —— 已物化的内容才能安全进入 Compartment/observation 的
 * basis；未物化的尾部绝不提前处理。
 */

/** Context lineage 物化边界输入（represented_through_context_seq）。null = 从未物化。 */
export interface LineageBoundaryInput {
  representedThroughContextSeq: number | null;
}

/** clamp 结果：eligible 上界（contextSeq 坐标）。 */
export function clampEligibleThroughContextSeq(
  frozenThroughContextSeq: number,
  lineage?: LineageBoundaryInput,
): number {
  const represented = lineage?.representedThroughContextSeq;
  if (represented === null || represented === undefined) {
    return frozenThroughContextSeq;
  }
  return Math.min(frozenThroughContextSeq, represented);
}

/**
 * 判定一次冻结批是否全部落在物化边界内（未物化尾部的批必须被 clamp，
 * 否则不得提交）。返回 clamped 后的 eligibleThroughContextSeq；
 * 若 clamped 后窗口为空（< from）→ 返回 0 表示"无 eligible 窗口"。
 */
export function clampBatchWindow(input: {
  fromContextSeq: number;
  throughContextSeq: number;
  lineage?: LineageBoundaryInput;
}): { eligibleThroughContextSeq: number; windowEmpty: boolean } {
  const clamped = clampEligibleThroughContextSeq(input.throughContextSeq, input.lineage);
  if (clamped < input.fromContextSeq) {
    return { eligibleThroughContextSeq: 0, windowEmpty: true };
  }
  return { eligibleThroughContextSeq: clamped, windowEmpty: false };
}
