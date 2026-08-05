/**
 * R3-P4：Pi Session compaction 授权（v13 "只有已进入 m0/m1 的 compartment 才可
 * 替换 raw P5" 的执行点）。
 *
 * 背景：R3-P0 移植的 Historian（B1–B8）没有 compaction 触发逻辑。v13 规格的
 * P5 边界（00-module-boundaries："P5 boundary 由 m0 + m1 已表示的最后一个
 * committed Compartment endEntrySeq 决定，Context 不读取 Historian
 * processedThroughEntrySeq 作为裁剪边界"）要求：只有已进入 m0/m1 的
 * compartment，其对应 raw Pi 条目才可被语义处理 / 从 Session 原文中安全裁剪。
 *
 * 本模块给出 compaction 的**授权**（authorization）：未来 Host/Pi 集成步骤在
 * 真正 trim 一条 raw Pi 条目之前，必须先调用本模块确认该条目已被物化且不在
 * 保护尾部（protected tail）内。授权结果 = min(protectedTailStartEntrySeq - 1,
 * lineageMaterializedEntrySeq)：
 *   - protectedTailStartEntrySeq：最新 HistorianBoundarySnapshot 的保护尾部起点
 *     （inclusive）。protectedTailStart - 1 是 raw 可裁剪的硬上界——保护尾部
 *     raw-inviolable，任何授权都绝不越过它；
 *   - lineageMaterializedEntrySeq：ContextHistoryReadPort 提供的物化 watermark
 *     （represented_through_context_seq 对应的 entrySeq）。null = 从未物化 /
 *     前缀内没有携带 entry_seq 的单元 → 没有任何 compartment 进入 m0/m1 →
 *     不授权任何裁剪（cut = 0）。
 *
 * 跨库规则（AGENTS.md）：本模块只消费 ContextHistoryReadPort 暴露的 VALUE
 * （seq 序号 / 状态字符串），绝不打开 context.db，绝不持有 Context 的 Repository /
 * ORM entity / 具体 Adapter；边界快照来自 Historian 自己的 store（historian.db，
 * 由 Historian 权威持有）。
 */

import type { HistorianBoundarySnapshot } from "../contracts/historian.js";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";

/** 授权结果的原因分类：
 *  - materialized：lineage 已物化（representedThroughEntrySeq != null），cut =
 *    min(protectedTailStartEntrySeq - 1, lineageMaterializedEntrySeq)；
 *  - no_m0_coverage：lineage 存在但从未物化（或会话尚无 lineage 行，端口
 *    fail-closed）→ 没有任何 compartment 进入 m0/m1 → cut = 0；
 *  - no_boundary：没有最新的 HistorianBoundarySnapshot → 保护尾部未知 →
 *    fail-closed，cut = 0。 */
export type CompactionAuthorizationReason = "materialized" | "no_m0_coverage" | "no_boundary";

/** 一次 compaction 授权的 VALUE（未来 Pi-trim 的输入）。 */
export interface CompactionAuthorization {
  runtimeSessionId: string;
  /** 可安全裁剪的 raw 条目上界（inclusive）。0 = 未授权任何裁剪。 */
  cutThroughEntrySeq: number;
  reason: CompactionAuthorizationReason;
  /** 本次授权依据的 protected tail 起点（inclusive；raw-inviolable）。 */
  protectedTailStartEntrySeq: number;
  /** Context lineage 物化 watermark（entrySeq 空间）；null = 从未物化。 */
  lineageMaterializedEntrySeq: number | null;
}

/**
 * 纯函数：计算 compaction 裁剪点。确定性、无 I/O。
 *
 *   cut = lineageMaterializedEntrySeq != null
 *           ? min(protectedTailStartEntrySeq - 1, lineageMaterializedEntrySeq)
 *           : 0
 *
 * 保证：
 *  - 返回值恒 ≤ protectedTailStartEntrySeq - 1（保护尾部绝不越过）；
 *  - 返回值为 0 = 不授权任何裁剪（lineage 从未物化，或保护尾部覆盖了整个会话）；
 *  - 任何输入下返回值 ≥ 0（对 protectedTailStartEntrySeq == 0 的防御性输入也
 *    不会返回负值）。
 */
export function authorizePiCompaction(input: {
  protectedTailStartEntrySeq: number;
  lineageMaterializedEntrySeq: number | null;
}): number {
  const { protectedTailStartEntrySeq, lineageMaterializedEntrySeq } = input;
  if (lineageMaterializedEntrySeq === null) {
    return 0; // lineage 从未物化 → 没有任何 compartment 可替换 raw
  }
  const cut = Math.min(protectedTailStartEntrySeq - 1, lineageMaterializedEntrySeq);
  return Math.max(0, cut);
}

/** 构造 CompactionAuthorizer 所需的窄源集合。 */
export interface CompactionAuthorizerSources {
  /** Context lineage 物化边界（values-only，跨库安全）。 */
  historyPort: ContextHistoryReadPort;
  /**
   * 保留的会话读取端口：未来 Host/Pi 集成在真正 trim raw 条目之前，用它读取
   * 当前 live head 以约束裁剪（边界快照的 observed head 可能早于会话最新增长）。
   * 同步的 authorize() 不读取它（契约保持同步），其角色是集成步骤的 live-head
   * 校验 seam。
   */
  sessionReadPort: import("../contracts/historian.js").RuntimeSessionHistoryReadPort;
  /** 该 session 最新 HistorianBoundarySnapshot（protected tail 的权威来源）。
   * undefined = 尚无边界（例如从未 freeze）→ 不授权。 */
  latestBoundaryFor: (runtimeSessionId: string) => HistorianBoundarySnapshot | undefined;
}

/** 一次授权的执行器。 */
export interface CompactionAuthorizer {
  authorize(runtimeSessionId: string): CompactionAuthorization;
}

/**
 * 组装 CompactionAuthorizer。同步、纯读取（只消费端口 VALUE + 边界快照）：
 *  1. 从 latestBoundaryFor 读取最新边界 → 无边界 = no_boundary（fail-closed）；
 *  2. 从 historyPort 读取 lineage 物化边界 → 端口对无 lineage 会话 fail-closed
 *     （抛错）→ 语义等价于"从未物化"→ no_m0_coverage（同样不授权）；
 *  3. 用纯函数 authorizePiCompaction 求 cut，按 lineage 是否为 null 归因。
 */
export function createCompactionAuthorizer(
  sources: CompactionAuthorizerSources,
): CompactionAuthorizer {
  return {
    authorize(runtimeSessionId: string): CompactionAuthorization {
      const boundary = sources.latestBoundaryFor(runtimeSessionId);
      if (boundary === undefined) {
        return {
          runtimeSessionId,
          cutThroughEntrySeq: 0,
          reason: "no_boundary",
          protectedTailStartEntrySeq: 0,
          lineageMaterializedEntrySeq: null,
        };
      }

      let lineageMaterializedEntrySeq: number | null;
      try {
        lineageMaterializedEntrySeq =
          sources.historyPort.getMaterializedBoundary(runtimeSessionId).representedThroughEntrySeq;
      } catch {
        // 会话尚无 lineage 行（端口 fail-closed）。与"从未物化"同义：没有任何
        // compartment 进入 m0/m1 → no_m0_coverage，不授权。
        lineageMaterializedEntrySeq = null;
      }

      const cutThroughEntrySeq = authorizePiCompaction({
        protectedTailStartEntrySeq: boundary.protectedTailStartEntrySeq,
        lineageMaterializedEntrySeq,
      });
      return {
        runtimeSessionId,
        cutThroughEntrySeq,
        reason: lineageMaterializedEntrySeq === null ? "no_m0_coverage" : "materialized",
        protectedTailStartEntrySeq: boundary.protectedTailStartEntrySeq,
        lineageMaterializedEntrySeq,
      };
    },
  };
}
