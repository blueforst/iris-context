/**
 * Phase E test helper：canonical BUST coordinator 测试环境（无任何 Pi 依赖）。
 * 组装 ContextStore + ContextIngest + HistorianStore + CommittedCompartmentReadPort
 * + MemoryIntegrationCoordinator + ContextRetirementPortV1。
 */
import { join } from "node:path";

import { ContextStore } from "../../src/context/context-store.js";
import { ContextIngest } from "../../src/context/context-ingest.js";
import { ContextAdmission } from "../../src/context/context-admission.js";
import { createContextRetirementPort } from "../../src/context/context-retirement-port.js";
import { createCommittedCompartmentReadPort } from "../../src/context/committed-compartment-read-port.js";
import { HistorianStore } from "../../src/historian/historian-store.js";
import { buildCompartment } from "../../src/historian/historian-compartment.js";
import { MemoryIntegrationCoordinator } from "../../src/memory/memory-integration-coordinator.js";
import { DSH_MESSAGE_REF_V1_SCHEMA_ID } from "../../src/contracts/context-unit.js";
import { makeLineageInput } from "./context-fixtures.js";

export interface BustEnvironment {
  contextStore: ContextStore;
  ingest: ContextIngest;
  /** Feature 3：统一 ContextUnit admission（P5 runtime-origin 主路径）。 */
  admission: ContextAdmission;
  historianStore: HistorianStore;
  retirementPort: ReturnType<typeof createContextRetirementPort>;
  committedCompartments: ReturnType<typeof createCommittedCompartmentReadPort>;
  memoryCoordinator: MemoryIntegrationCoordinator;
}

/** 组装 BUST 测试环境（memoryCoordinator 可先不挂 adapter = zero-backend）。 */
export function openBustEnvironment(dir: string, lineageId: string): BustEnvironment {
  const contextStore = ContextStore.open(join(dir, "context.db"), { lineageId });
  contextStore.createLineage(makeLineageInput("session-1", lineageId));
  const ingest = new ContextIngest(contextStore, lineageId);
  const admission = new ContextAdmission(contextStore);
  const historianStore = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const retirementPort = createContextRetirementPort(contextStore);
  const committedCompartments = createCommittedCompartmentReadPort(historianStore);
  const memoryCoordinator = new MemoryIntegrationCoordinator();
  return {
    contextStore,
    ingest,
    admission,
    historianStore,
    retirementPort,
    committedCompartments,
    memoryCoordinator,
  };
}

/**
 * Feature 3：经统一 ContextAdmission 接纳一个 runtime-origin P5 单元
 * （DshMessageRef source；canonical content）。返回 admitted unitId。
 */
export function admitRuntimeMessage(
  env: BustEnvironment,
  messageId: string,
  content: string,
  sessionId = "session-1",
  kind: "user" | "assistant" | "tool_result" = "user",
): string {
  const schemaByKind: Record<"user" | "assistant" | "tool_result", string> = {
    user: "iris.semantic.context_message.user.v1",
    assistant: "iris.semantic.context_message.assistant.v1",
    tool_result: "iris.semantic.context_message.tool_result.v1",
  };
  const contentByKind: Record<"user" | "assistant" | "tool_result", unknown> = {
    user: { role: "user", content },
    assistant: { role: "assistant", content, timestamp: 1 },
    tool_result: {
      role: "toolResult",
      toolCallId: `tool-${messageId}`,
      toolName: "echo",
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: 1,
    },
  };
  const unit = env.admission.admit({
    sourceRef: {
      schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
      sessionId,
      messageId,
    },
    contentSchemaId: schemaByKind[kind],
    content: contentByKind[kind] as never,
    runtimeSessionId: sessionId,
  });
  return unit.unitId;
}

/** 从 units 构建并插入一个 committed Compartment（模拟 Historian commit 产物）。
 * 返回构建出的 HistoricalCompartment（测试可用其 source 计算 P3 unitId）。
 * units 为统一 ContextUnit + sidecar（HistorianBatchUnit 形状）。 */
export function commitCompartment(
  env: BustEnvironment,
  compartmentSequence: number,
  units: import("../../src/contracts/historian.js").HistorianBatchUnit[],
): import("../../src/historian/historian-compartment.js").HistoricalCompartment {
  const built = buildCompartment({
    lineageId: env.contextStore.lineageId,
    runtimeSessionId: "session-1",
    compartmentSequence,
    units,
  });
  if (built === null) {
    throw new Error("commitCompartment: no compartment built (all units excluded?)");
  }
  env.historianStore.begin();
  try {
    env.historianStore.insertCompartment(built.compartment);
    env.historianStore.insertAttributionManifest(built.attributionManifest);
    env.historianStore.commit();
  } catch (error) {
    env.historianStore.rollback();
    throw error;
  }
  return built.compartment;
}

/**
 * Feature 5：把 lineage 闭区间内的统一 ContextUnit + sidecar 转换为
 * HistorianBatchUnit（供 commitCompartment 模拟 Historian 输入）。
 */
export function historianBatchUnitsOf(
  env: BustEnvironment,
  fromContextSeq: number,
  toContextSeq: number,
): import("../../src/contracts/historian.js").HistorianBatchUnit[] {
  return env.contextStore
    .listContextUnitsWithState(env.contextStore.lineageId, fromContextSeq, toContextSeq)
    .map((entry) => ({
      unit: entry.unit,
      contextSeq: entry.state.contextSeq,
      ...(entry.state.kind !== undefined ? { kind: entry.state.kind } : {}),
      historianDisposition: entry.state.historianDisposition,
      ...(entry.unit.derivation !== undefined ? { derivation: entry.unit.derivation } : {}),
      createdAt: entry.state.createdAt,
    }));
}
