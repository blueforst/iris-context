/**
 * Context module contracts (v27+ cleanup).
 *
 * 本文件在 v27–v29 清理后不再承载运行时契约定义：`InvocationSourceBinding` /
 * `TransformMessagesInput` / `MessageProjectionResult` / `IrisContextCarrierDetails`
 * / `M0_EMPTY_BODY` / `M1_EMPTY_PLACEHOLDER` / `IRIS_INPUT_META_*` 等废止概念
 * 已全部删除（m0/m1、carrier、prepareInvocationSources/transformMessages 不属于
 * 当前 Context Assembly contract，Notion v27 Legacy Assembly Contract Cleanup）。
 *
 * Context 的权威契约现在位于：
 *   - src/contracts/runtime-events.ts —— runtime-neutral committed input port
 *     （RuntimeEventInput / CanonicalRuntimeEventV1 / RuntimeEventIngestPort）；
 *   - src/contracts/context-v27.ts（+ contracts/generated/）—— 生成式
 *     ContextMessageUnitV1 / ContextGenerationV2 机器权威；
 *   - src/context/context-ingest.ts —— ContextIngestPort + ContextUnitStorePort。
 */

export {};
