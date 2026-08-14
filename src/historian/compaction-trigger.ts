/**
 * Compaction 授权（Phase D，contextSeq 坐标）—— 去 m0/m1 措辞。
 *
 * v29：Context 冻结完整 semantic boundary；只有已进入 Compartment（已物化）
 * 的内容才能被后续归档/裁剪。本模块给出 raw archive 裁剪的**授权**：
 *
 *   cut = lineageMaterializedThroughContextSeq != null
 *           ? min(protectedTailStartContextSeq - 1, lineageMaterializedThroughContextSeq)
 *           : 0
 *
 *  - protectedTailStartContextSeq：最新冻结 batch 的保护尾部起点（inclusive）。
 *    保护尾部 raw-inviolable，任何授权都绝不越过它；
 *  - lineageMaterializedThroughContextSeq：Context lineage 的物化 watermark
 *    （representedThroughContextSeq，Context 坐标）。null = 从未物化 → 不授权。
 *
 * 跨库规则（AGENTS.md）：本模块只消费 ContextHistoryReadPort 暴露的 VALUE
 * （contextSeq / 状态字符串），绝不打开 context.db；冻结 batch 来自
 * Historian 自己的 store（historian.db，Historian 权威持有）。
 */

import type { ContextHistoryReadPort } from "../context/history-read-port.js";

export type CompactionAuthorizationReason = "materialized" | "no_coverage" | "no_boundary";

/** 一次 compaction 授权的 VALUE（未来 raw-archive trim 的输入；contextSeq 坐标）。 */
export interface CompactionAuthorization {
  lineageId: string;
  /** 可安全裁剪的 raw 条目上界（inclusive contextSeq）。0 = 未授权任何裁剪。 */
  cutThroughContextSeq: number;
  reason: CompactionAuthorizationReason;
  /** 本次授权依据的 protected tail 起点（inclusive；raw-inviolable）。 */
  protectedTailStartContextSeq: number;
  /** Context lineage 物化 watermark（contextSeq 空间）；null = 从未物化。 */
  lineageMaterializedThroughContextSeq: number | null;
}

/**
 * 纯函数：计算 compaction 裁剪点。确定性、无 I/O。
 *
 * 保证：返回值恒 ≤ protectedTailStartContextSeq - 1（保护尾部绝不越过）；
 * 返回值为 0 = 不授权任何裁剪；任何输入下返回值 ≥ 0。
 */
export function authorizeCompaction(input: {
  protectedTailStartContextSeq: number;
  lineageMaterializedThroughContextSeq: number | null;
}): number {
  const { protectedTailStartContextSeq, lineageMaterializedThroughContextSeq } = input;
  if (lineageMaterializedThroughContextSeq === null) {
    return 0;
  }
  const cut = Math.min(protectedTailStartContextSeq - 1, lineageMaterializedThroughContextSeq);
  return Math.max(0, cut);
}

/** 构造 CompactionAuthorizer 所需的窄源集合。 */
export interface CompactionAuthorizerSources {
  /** Context lineage 物化边界（values-only，跨库安全）。 */
  historyPort: ContextHistoryReadPort;
  /**
   * 该 lineage 最新冻结 batch 的保护尾部起点（inclusive contextSeq）。
   * undefined = 尚无边界 → 不授权。
   */
  latestProtectedTailStartContextSeq: () => number | undefined;
}

export interface CompactionAuthorizer {
  authorize(): CompactionAuthorization;
}

/**
 * 组装 CompactionAuthorizer。同步、纯读取：
 *  1. 读取最新保护尾部起点 → 无边界 = no_boundary（fail-closed）；
 *  2. 读取 lineage 物化边界 → 端口对无 lineage 会话 fail-closed → 语义等价于
 *     "从未物化" → no_coverage（不授权）；
 *  3. 纯函数 authorizeCompaction 求 cut。
 */
export function createCompactionAuthorizer(
  lineageId: string,
  sources: CompactionAuthorizerSources,
): CompactionAuthorizer {
  return {
    authorize(): CompactionAuthorization {
      const protectedTailStartContextSeq = sources.latestProtectedTailStartContextSeq();
      if (protectedTailStartContextSeq === undefined) {
        return {
          lineageId,
          cutThroughContextSeq: 0,
          reason: "no_boundary",
          protectedTailStartContextSeq: 0,
          lineageMaterializedThroughContextSeq: null,
        };
      }
      let lineageMaterializedThroughContextSeq: number | null;
      try {
        lineageMaterializedThroughContextSeq =
          sources.historyPort.getMaterializedBoundary(lineageId).representedThroughContextSeq;
      } catch {
        lineageMaterializedThroughContextSeq = null;
      }
      const cutThroughContextSeq = authorizeCompaction({
        protectedTailStartContextSeq,
        lineageMaterializedThroughContextSeq,
      });
      return {
        lineageId,
        cutThroughContextSeq,
        reason: lineageMaterializedThroughContextSeq === null ? "no_coverage" : "materialized",
        protectedTailStartContextSeq,
        lineageMaterializedThroughContextSeq,
      };
    },
  };
}
