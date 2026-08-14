/**
 * Phase F（Cordis）：iris-context 的 Cordis service/facet 层。
 *
 * 导出的 typed services（带 `iris` 前缀，经 `declare module '@deepseek-ai/cordis'`
 * 挂到 ctx）：
 *  - `ctx.irisContext`  —— ContextService（ContextStore + ContextIngest +
 *    BustCoordinator + 当前 generation）；
 *  - `ctx.irisHistorian` —— HistorianService（HistorianStore + HistorianManager；
 *    inject=['irisContext']）；
 *  - `ctx.irisMemory`    —— MemoryService（Memory Integration Coordinator；
 *    zero-or-one adapter；BUST-only recall）。
 *
 * 装配：`createIrisContextPlugin(config)`（单个 root plugin）/ `installIrisContext`；
 * Identity scope 装配点：`installIrisIdentityScope`。
 */

export * from "./context-service.js";
export * from "./historian-service.js";
export * from "./memory-service.js";
export * from "./plugin.js";
export * from "./types.js";
