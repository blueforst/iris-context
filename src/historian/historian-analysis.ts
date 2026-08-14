/**
 * Historian analysis view + PURE range validation（Phase D，contextSeq 坐标）。
 *
 * v29：Historian 唯一输入是 ContextHistoryReadPort.freezeBatch 冻结的
 * HistorianBatchV1（有限、不可变、带 rangeHash）。本模块在 commit 前
 * PURE 地重新验证（无 I/O、确定性）：
 *   - 批窗口端点不变量：fromContextSeq 严格等于 durable cursor+1（claim 锚定）；
 *   - source range hash 不变量：冻结 hash 必须与当前批的 ordered unit 身份
 *     （contextSeq:contextUnitId:contentHash）重新计算一致 —— 内容漂移
 *     fail-closed，绝不 commit 到漂移窗口；
 *   - 零进度（空批）→ no_safe_prefix，调用方绝不推进 cursor。
 *
 * 失败验证绝不推进 cursor（Notion：claim 后未 commit → lease 到期重试相同
 * batch；receipt 与 frozen batch hash 不一致 → fail closed 并进入修复流程）。
 */

import { historianBatchRangeHash } from "../contracts/historian.js";
import type { HistorianBatchV1 } from "../contracts/historian.js";
import type { ContextMessageUnitV1 } from "../contracts/context-v27.js";

/** The pure analysis view over a frozen batch. */
export interface HistorianAnalysisView {
  lineageId: string;
  batch: HistorianBatchV1;
  /** The FINITE eligible units of the batch (never wider than the batch). */
  units: ContextMessageUnitV1[];
  /** Raw eligible tokens (estimate). */
  trueRawEligibleTokens: number;
}

export type ValidationOutcome =
  | {
      ok: true;
      commitThroughContextSeq: number;
    }
  | { ok: false; errorCode: string; detail: string };

/** Build the analysis view (pure). The batch is the authoritative finite window. */
export function buildAnalysisView(batch: HistorianBatchV1): HistorianAnalysisView {
  const rawTokens = batch.units.reduce(
    (total, unit) => total + JSON.stringify(unit.semanticContent).length,
    0,
  );
  return {
    lineageId: batch.contextLineageId,
    batch,
    units: batch.units,
    trueRawEligibleTokens: Math.max(1, Math.ceil(rawTokens / 4)),
  };
}

/**
 * PURE validation of the frozen batch against the durable cursor.
 *
 * 1. Claim anchor: batch.fromContextSeq MUST equal the durable cursor + 1.
 *    A batch that does not start exactly after the cursor cannot be committed
 *    (it would skip or re-claim processed units).
 * 2. Range hash invariant: recompute the deterministic hash over the EXACT
 *    ordered unit identities and compare to the frozen batch.rangeHash.
 * 3. Zero progress: an empty window (through < from) is no_safe_prefix.
 */
export function validateRange(input: {
  batch: HistorianBatchV1;
  unprocessedFromContextSeq: number;
}): ValidationOutcome {
  const { batch } = input;

  if (batch.fromContextSeq !== input.unprocessedFromContextSeq) {
    return {
      ok: false,
      errorCode: "claim_anchor_mismatch",
      detail:
        `batch starts at ${batch.fromContextSeq} but the durable cursor implies ` +
        `${input.unprocessedFromContextSeq} (claim must start strictly after the cursor)`,
    };
  }

  if (batch.units.length === 0 || batch.throughContextSeq < batch.fromContextSeq) {
    return {
      ok: false,
      errorCode: "no_safe_prefix",
      detail: `no safe prefix: empty batch window [${batch.fromContextSeq}..${batch.throughContextSeq}]`,
    };
  }

  // Endpoint invariant: the batch must never exceed the frozen ceiling. The
  // frozen ceiling is the batch itself (Context froze the full semantic
  // boundary); a re-claimed batch with the same window must produce the same
  // hash — any mismatch is Content drift (fail closed).
  const computedHash = historianBatchRangeHash({
    contextLineageId: batch.contextLineageId,
    fromContextSeq: batch.fromContextSeq,
    throughContextSeq: batch.throughContextSeq,
    units: batch.units,
  });
  if (computedHash !== batch.rangeHash) {
    return {
      ok: false,
      errorCode: "source_range_hash_mismatch",
      detail:
        `range hash ${computedHash.slice(0, 12)} != frozen ${batch.rangeHash.slice(0, 12)} ` +
        `for window [${batch.fromContextSeq}..${batch.throughContextSeq}]`,
    };
  }

  return {
    ok: true,
    commitThroughContextSeq: batch.throughContextSeq,
  };
}
