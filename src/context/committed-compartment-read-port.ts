/**
 * CommittedCompartmentReadPort —— canonical BUST P3 的窄读取端口（Phase E）。
 *
 * 权威来源：Notion v27–v29 —— P3 只消费 Historian 提供的 committed current
 * Compartment revisions；BUST full-rebuild 从 durable committed Compartments
 * 重建 P3，绝不从 context.db 复制 Compartment 正文，也绝不建立第二套
 * Compartment 权威。
 *
 * 本端口只暴露 VALUE（不可变 HistoricalCompartment）；BUST coordinator 通过
 * 本窄接口消费 HistorianStore 的只读视图，绝不直接持有 historian.db 句柄。
 */

import type { HistoricalCompartment } from "../historian/historian-compartment.js";
import type { HistorianStore } from "../historian/historian-store.js";

/** 窄、版本化的 committed Compartment 读端口（values-only）。 */
export interface CommittedCompartmentReadPort {
  /**
   * 读取某 lineage 的全部 committed CompartmentRevision，按
   * compartment_sequence 升序（P3 projection 的确定性顺序）。
   */
  listCommitted(lineageId: string): readonly HistoricalCompartment[];
}

/** 把 HistorianStore 的只读视图适配为窄读端口（values-only，无 db 句柄泄漏）。 */
export function createCommittedCompartmentReadPort(
  store: HistorianStore,
): CommittedCompartmentReadPort {
  return {
    listCommitted(lineageId: string): readonly HistoricalCompartment[] {
      return store.listCommittedCompartments(lineageId);
    },
  };
}
