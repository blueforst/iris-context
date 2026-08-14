/**
 * Phase E test helper：canonical BUST coordinator 测试环境（无任何 Pi 依赖）。
 * 组装 ContextStore + ContextIngest + HistorianStore + CommittedCompartmentReadPort
 * + MemoryIntegrationCoordinator + ContextRetirementPortV1。
 */
import { join } from "node:path";

import { ContextStore } from "../../src/context/context-store.js";
import { ContextIngest } from "../../src/context/context-ingest.js";
import { createContextRetirementPort } from "../../src/context/context-retirement-port.js";
import { createCommittedCompartmentReadPort } from "../../src/context/committed-compartment-read-port.js";
import { HistorianStore } from "../../src/historian/historian-store.js";
import { buildCompartment } from "../../src/historian/historian-compartment.js";
import { MemoryIntegrationCoordinator } from "../../src/memory/memory-integration-coordinator.js";
import type { ContextMessageUnitV1 } from "../../src/contracts/context-v27.js";
import { makeLineageInput } from "./context-fixtures.js";

export interface BustEnvironment {
  contextStore: ContextStore;
  ingest: ContextIngest;
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
  const historianStore = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const retirementPort = createContextRetirementPort(contextStore);
  const committedCompartments = createCommittedCompartmentReadPort(historianStore);
  const memoryCoordinator = new MemoryIntegrationCoordinator();
  return {
    contextStore,
    ingest,
    historianStore,
    retirementPort,
    committedCompartments,
    memoryCoordinator,
  };
}

/** 从 units 构建并插入一个 committed Compartment（模拟 Historian commit 产物）。 */
export function commitCompartment(
  env: BustEnvironment,
  compartmentSequence: number,
  units: ContextMessageUnitV1[],
): void {
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
}
