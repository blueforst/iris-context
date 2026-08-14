/**
 * Phase F（Cordis）：iris 服务的类型化增广。
 *
 * 通过 `declare module '@deepseek-ai/cordis'` 把三个带 `iris` 前缀的 typed
 * services 挂到 `Context`，并把 iris 事件族挂到 `Events`（typed events）。
 * 所有 listener 随注册 fiber 自动清理（Cordis `ctx.on` 语义）。
 *
 * 事件命名约定（DSH §4.2）：`<域>/<动词>`；本仓库域为 `iris`。
 * 事件均为 `@mode emit`（同步、不等返回）。
 */
import type { ContextGenerationV3 } from "../../contracts/generated/types.js";
import type { HistorianCommitReceiptV1 } from "../contracts/historian.js";
import type { BustReason } from "../context/bust-coordinator.js";
import type { ContextService } from "./context-service.js";
import type { HistorianService } from "./historian-service.js";
import type { MemoryService } from "./memory-service.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Identity scope 的 Context 服务（ContextStore + ContextIngest + BustCoordinator）。 */
    irisContext: ContextService;
    /** Identity scope 的 Historian 服务（HistorianStore + HistorianManager）。 */
    irisHistorian: HistorianService;
    /** Identity scope 的 Memory Integration Coordinator 服务（zero-or-one adapter）。 */
    irisMemory: MemoryService;
  }

  interface Events {
    /**
     * canonical BUST 请求已提交（coalesce 前的原始 reason，审计/可观测）。
     * @mode emit
     */
    "iris/bust-requested"(reason: BustReason): void;

    /**
     * canonical BUST 已成功原子发布新 generation（唯一 materializer 的输出）。
     * @mode emit
     */
    "iris/context-generation-published"(generation: ContextGenerationV3): void;

    /**
     * Historian 已原子提交一个 batch（commit protocol 的 receipt 已产出；
     * 下游 facet 可据此 requestBust）。
     * @mode emit
     */
    "iris/historian-batch-committed"(receipt: HistorianCommitReceiptV1): void;
  }
}
