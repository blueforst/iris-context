/**
 * ContextRetirementPortV1 的 Context 侧实现（context.db 唯一权威 owner）。
 *
 * Context 模块实现窄 retirement 端口；Historian 只消费 VALUE（receipt），
 * 绝不持有 context.db 句柄。`acknowledgeHistorianCommit` 委托给
 * ContextStore（幂等标记 compartmentalized_pending_bust）；Phase E 的
 * `markRepresentedAndRetired` / `reclaimRetiredPayloads` 保持 fail-closed。
 */

import type {
  ContextRetirementPortV1,
  ReclaimRetiredInput,
  RepresentAndRetireInput,
} from "../contracts/context-retirement.js";
import { RetirementNotImplementedError } from "../contracts/context-retirement.js";
import type { HistorianCommitReceiptV1 } from "../contracts/historian.js";
import type { ContextStore } from "./context-store.js";

/** 用 ContextStore 装配 ContextRetirementPortV1。 */
export function createContextRetirementPort(store: ContextStore): ContextRetirementPortV1 {
  return {
    acknowledgeHistorianCommit(receipt: HistorianCommitReceiptV1): void {
      store.acknowledgeHistorianCommit(receipt);
    },
    markRepresentedAndRetired(input: RepresentAndRetireInput): void {
      void input;
      throw new RetirementNotImplementedError("markRepresentedAndRetired");
    },
    reclaimRetiredPayloads(input: ReclaimRetiredInput): void {
      void input;
      throw new RetirementNotImplementedError("reclaimRetiredPayloads");
    },
  };
}
