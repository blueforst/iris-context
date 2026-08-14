/**
 * Phase E + iris-context#2：P4 Recollection（BUST-only）单元测试。
 *
 * 证明：
 *  - zero-backend（MemoryIntegrationCoordinator 无 adapter）→ P4 空数组（合法）；
 *  - backend 返回 RecollectionSnapshot → P4 投影（净化/去重/budget/排序）；
 *  - provider 不可用 → 显式 unavailable marker（不伪装为"无记忆"）；
 *  - backend 只能返回 snapshot（接口层面无法创建 ContextUnit）；
 *  - 同一 snapshot → 确定性 sourceRef / materialize 后同一 ContextUnit；
 *  - P4 不推进 retirement（由 BUST coordinator 保证；本套件验证 projector
 *    不触碰任何 watermark）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryIntegrationCoordinator,
  type MemoryRecallResult,
  type MemoryServiceAdapter,
  type RecallIntent,
} from "../src/memory/memory-integration-coordinator.js";
import { P4RecollectionProjector } from "../src/context/p4-recollection.js";
import { materializeContextUnit } from "../src/context/context-admission.js";
import { isGenericSourceRef } from "../src/contracts/context-unit.js";
import type { AdmissionCandidate } from "../src/context/context-admission.js";

const LINEAGE = "lineage-p4-test";

function intent(): RecallIntent {
  return {
    schemaId: "iris.recall_intent.v1",
    contextLineageId: LINEAGE,
    contextGenerationId: "bust-1",
    frozenAt: "2026-08-01T00:00:00.000Z",
    querySummary: "lineage test",
    budget: { maxCandidates: 64 },
    sourceSnapshotHash: "snap-1",
  };
}

/** 可控 fake adapter（mock 行为显式标注）。 */
class FakeMemoryAdapter implements MemoryServiceAdapter {
  readonly serviceId = "fake-memory";
  readonly epoch = "epoch-1";
  revision = "rev-1";
  statusValue: "ready" | "unavailable" | "error" = "ready";
  result: MemoryRecallResult = { status: "ready", candidates: [] };
  recalledIntents: RecallIntent[] = [];

  status(): "ready" | "unavailable" | "error" {
    return this.statusValue;
  }
  async recall(input: RecallIntent): Promise<MemoryRecallResult> {
    this.recalledIntents.push(input);
    if (this.statusValue === "error") {
      throw new Error("fake memory recall exploded");
    }
    return { ...this.result };
  }
}

function projector(): P4RecollectionProjector {
  return new P4RecollectionProjector();
}

function projectAll(
  snapshot: Parameters<P4RecollectionProjector["project"]>[0],
): AdmissionCandidate[] {
  return projector().project(snapshot, { contextLineageId: LINEAGE, maxCandidates: 64 });
}

test("P4: zero-backend → coordinator status disabled and P4 is empty", async () => {
  const coordinator = new MemoryIntegrationCoordinator();
  assert.equal(coordinator.isConfigured(), false);
  assert.equal(coordinator.getStatus(), "disabled");
  const snapshot = await coordinator.recall(intent());
  assert.equal(snapshot.status, "disabled");
  assert.equal(snapshot.candidates.length, 0);
  const candidates = projectAll(snapshot);
  assert.deepEqual(candidates, [], "zero-backend → P4 空数组");
});

test("P4: ready backend → candidates projected with validation/sanitize/dedupe/order", async () => {
  const adapter = new FakeMemoryAdapter();
  adapter.result = {
    snapshotId: "snapshot-1",
    revision: "rev-9",
    status: "ready",
    recalledAt: "2026-08-01T00:00:00.000Z",
    candidates: [
      {
        recollectionId: "r-b",
        statement: "lower relevance",
        sourceTrust: "generated",
        relevanceScore: 0.2,
      },
      {
        recollectionId: "r-a",
        statement: "higher relevance",
        sourceTrust: "observed",
        relevanceScore: 0.9,
      },
      {
        recollectionId: "r-b",
        statement: "DUPLICATE ID ignored",
        sourceTrust: "verified",
        relevanceScore: 0.9,
      },
      {
        recollectionId: "r-c",
        statement: "duplicate statement",
        sourceTrust: "verified",
        relevanceScore: 0.5,
      },
      {
        recollectionId: "r-d",
        statement: "duplicate statement",
        sourceTrust: "verified",
        relevanceScore: 0.5,
      },
      { recollectionId: "r-e", statement: "  ", sourceTrust: "verified", relevanceScore: 0.5 },
      // 畸形 candidate（缺 statement）→ 丢弃
      { recollectionId: "r-f", sourceTrust: "observed" } as never,
    ],
  };
  const coordinator = new MemoryIntegrationCoordinator({ adapter });
  const snapshot = await coordinator.recall(intent());
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.snapshotId, "snapshot-1");
  assert.equal(snapshot.revision, "rev-9");
  const candidates = projectAll(snapshot);
  // 去重：r-b 只保留首个（score 0.2）；duplicate statement 只保留首个（r-c）；
  // r-e（空语句）丢弃；r-f（畸形）丢弃。剩余 r-a / r-b / r-c。
  assert.equal(candidates.length, 3);
  // 排序：relevanceScore 降序 → r-a(0.9), r-c(0.5), r-b(0.2)
  assert.deepEqual(
    candidates.map((u) => (u.content as Record<string, unknown>)["recollectionId"]),
    ["r-a", "r-c", "r-b"],
  );
  // sourceRef 绑定 snapshot identity/revision/hash
  for (const candidate of candidates) {
    assert.ok(isGenericSourceRef(candidate.sourceRef), "P4 sourceRef is a generic source ref");
    const ref = candidate.sourceRef as Extract<
      import("../src/contracts/context-unit.js").ContextUnitSourceRef,
      { schemaId: "iris.context_unit_source_ref.v1" }
    >;
    assert.equal(ref.sourceSchemaId, "iris.recollection_snapshot.v1");
    assert.equal(ref.sourceId, "snapshot-1");
    assert.equal(ref.sourceRevision, "rev-9");
    assert.equal(ref.sourceHash, snapshot.snapshotHash);
    assert.equal(candidate.contentSchemaId, "iris.semantic.recollection.v1");
  }
  // materialize 后 ContextUnit identity 确定性（同一 snapshot → 同一 unitId）
  const again = projectAll(snapshot);
  assert.deepEqual(
    candidates.map((u) => materializeContextUnit(LINEAGE, u).unitId),
    again.map((u) => materializeContextUnit(LINEAGE, u).unitId),
  );
  // snapshot hash 确定性
  const snapshot2 = await coordinator.recall(intent());
  assert.equal(snapshot2.snapshotHash, snapshot.snapshotHash);
});

test("P4: budget caps candidates after ordering (keeps most relevant)", async () => {
  const adapter = new FakeMemoryAdapter();
  adapter.result = {
    snapshotId: "snapshot-budget",
    revision: "rev-1",
    status: "ready",
    candidates: [
      { recollectionId: "r1", statement: "s1", sourceTrust: "observed", relevanceScore: 0.1 },
      { recollectionId: "r2", statement: "s2", sourceTrust: "observed", relevanceScore: 0.9 },
      { recollectionId: "r3", statement: "s3", sourceTrust: "observed", relevanceScore: 0.5 },
    ],
  };
  const coordinator = new MemoryIntegrationCoordinator({ adapter });
  const snapshot = await coordinator.recall(intent());
  const candidates = projector().project(snapshot, { contextLineageId: LINEAGE, maxCandidates: 2 });
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((u) => (u.content as Record<string, unknown>)["recollectionId"]),
    ["r2", "r3"],
    "budget keeps highest relevance",
  );
});

test("P4: unavailable backend → explicit marker candidate, never disguised as empty", async () => {
  const adapter = new FakeMemoryAdapter();
  adapter.statusValue = "unavailable";
  const coordinator = new MemoryIntegrationCoordinator({ adapter });
  const snapshot = await coordinator.recall(intent());
  assert.equal(snapshot.status, "unavailable");
  assert.ok(snapshot.unavailableReason !== undefined, "explicit unavailableReason");
  const candidates = projectAll(snapshot);
  assert.equal(candidates.length, 1, "unavailable → one explicit marker candidate (not empty)");
  const content = candidates[0]?.content as Record<string, unknown>;
  assert.equal(content["status"], "unavailable");
  assert.equal(typeof content["unavailableReason"], "string");
  assert.equal(candidates[0]?.contentSchemaId, "iris.semantic.recollection.v1");
});

test("P4: adapter recall throwing → unavailable snapshot (not a silent empty)", async () => {
  const adapter = new FakeMemoryAdapter();
  adapter.statusValue = "error";
  const coordinator = new MemoryIntegrationCoordinator({ adapter });
  const snapshot = await coordinator.recall(intent());
  assert.equal(snapshot.status, "unavailable");
  const candidates = projectAll(snapshot);
  assert.equal(candidates.length, 1);
  assert.equal((candidates[0]?.content as Record<string, unknown>)["status"], "unavailable");
});

test("P4: backend cannot create ContextUnit — the adapter returns a data snapshot only", async () => {
  // 接口层面 MemoryServiceAdapter.recall 的返回类型是 MemoryRecallResult
  // （snapshot 数据），没有任何字段能承载 ContextUnit；这里用一个
  // mock 编译期断言：adapter 的返回值不满足 ContextUnit 形状。
  const adapter = new FakeMemoryAdapter();
  const coordinator = new MemoryIntegrationCoordinator({ adapter });
  const snapshot = await coordinator.recall(intent());
  const unit = (snapshot as unknown as { header?: unknown }).header;
  assert.equal(unit, undefined, "snapshot carries no ContextUnit header");
  assert.equal(
    (snapshot as unknown as { schemaId?: string }).schemaId,
    "iris.recollection_snapshot.v1",
  );
});

test("P4: projector never touches retirement/watermarks (no such API)", () => {
  const projectorInstance = projector();
  const api = Object.getOwnPropertyNames(Object.getPrototypeOf(projectorInstance));
  for (const name of api) {
    assert.ok(
      !/retir|reclaim|markRepresented|watermark|store|contextLineages/i.test(name),
      `projector API ${name} must not touch retirement/watermarks/store`,
    );
  }
});
