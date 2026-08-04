import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { RuntimeEventDerivationRefs } from "./runtime-events.js";

/** R2：不可变 ContextMessageUnit（Roadmap v13 canonical chain 的语义单元）。 */
export type ContextUnitType = "input" | "assistant" | "tool_result";

export interface ContextMessageUnit {
  runtimeSessionId: string;
  /** 每 session 单调（R3 Historian 的读取序）。 */
  contextSeq: number;
  unitId: string;
  /** 源 runtime event（exactly-once：一个事件最多一个单元）。 */
  sourceEventId: string;
  unitType: ContextUnitType;
  disposition: "include" | "reference_only" | "exclude";
  entryId?: string;
  entrySeq?: number;
  contentHash: string;
  /** canonical provider-visible 序列化（非 raw 原文副本）。 */
  payload: AgentMessage;
  companionEntryId?: string;
  pairKey?: string;
  /** companion 配对是否在 ingest 时验证通过。 */
  paired: boolean;
  derivationRefs: RuntimeEventDerivationRefs;
  createdAt: string;
}

/** R2：Context ingest 的窄、版本化契约（可重放、exactly-once）。 */
export interface ContextIngestPort {
  /**
   * 确定性可重放投影：从 runtime-event ledger 读取已提交事件，为缺失的
   * message_finalized 事件创建 ContextMessageUnit（含 companion 配对折叠），
   * 返回该 session 的全部单元。跨库崩溃（事件已提交、单元未建）由下一次
   * ensureUnitsUpTo 自愈。
   */
  ensureUnitsUpTo(runtimeSessionId: string, options?: { limit?: number }): ContextMessageUnit[];
  listUnits(
    runtimeSessionId: string,
    options?: { afterContextSeq?: number; limit?: number },
  ): ContextMessageUnit[];
  close(): void;
}
