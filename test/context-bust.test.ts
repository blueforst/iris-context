/**
 * Phase E：canonical BUST coordinator 端到端测试。
 *
 * 证明（Notion v27–v29 Canonical BUST）：
 *  - requestBust 合并（多次请求 coalesce 为一次 rebuild）；
 *  - 成功 BUST：完整 P0–P5 generation、layerEnds 正确、原子发布、generation
 *    id+hash 绑定、represented/retired watermark 推进、live units 被 P3 表示
 *    后从 P5 离开；
 *  - 失败 fail-closed：不发布半 generation、watermark 不推进、无 previous
 *    fallback（旧 generation 不被新请求使用）；
 *  - P4：zero-backend → P4 空；backend ready → P4 投影；unavailable → 显式
 *    marker；P4 不推进 retirement；
 *  - 无 LKG/previous-generation 持久化。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BustCoordinator,
  createBustCoordinator,
  type ContextSourceContributor,
} from "../src/context/bust-coordinator.js";
import { unitsInLayer } from "../src/context/generation-builder.js";
import {
  type MemoryRecallResult,
  type MemoryServiceAdapter,
} from "../src/memory/memory-integration-coordinator.js";
import {
  newClaimId,
  newReceiptId,
  type HistorianCommitReceiptV1,
} from "../src/contracts/historian.js";
import { assistantInput, cleanupDir, tempDir, userInput } from "./helpers/context-fixtures.js";
import {
  commitCompartment,
  openBustEnvironment,
  type BustEnvironment,
} from "./helpers/bust-fixtures.js";

const LINEAGE = "lineage-bust-test";

function makeContributor(
  layer: "p0" | "p1" | "p2",
  sourceId: string,
  units: ReturnType<typeof bustEnvContributorUnits>,
): ContextSourceContributor {
  return {
    layer,
    sourceId,
    sourceRevision: "1",
    sourceHash: `hash-${sourceId}`,
    project: () => units,
    invalidate: (id) => id === sourceId,
  };
}

function bustEnvContributorUnits(text: string) {
  return [
    {
      contextUnitId: `static-${text}`,
      source: {
        schemaId: "iris.context_unit_source_ref.v1" as const,
        sourceSchemaId: "test.static.v1",
        sourceId: `source-${text}`,
        sourceHash: `hash-${text}`,
      },
      semanticSchemaId: "iris.semantic.context_message.user.v1",
      semanticContent: { role: "user", content: text },
    },
  ];
}

function receiptFor(
  from: number,
  through: number,
  compartmentId: string,
): HistorianCommitReceiptV1 {
  const claimId = newClaimId();
  return {
    schemaId: "iris.historian_commit_receipt.v1",
    receiptId: newReceiptId(`batch-${from}-${through}`, claimId),
    batchId: `batch-${from}-${through}`,
    claimId,
    contextLineageId: LINEAGE,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: `rh-${from}-${through}`,
    compartmentIds: [compartmentId],
    publicationIds: [],
    outputHash: "oh",
    committedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeCoordinator(
  env: BustEnvironment,
  options: { contributors?: ContextSourceContributor[]; p4MaxCandidates?: number } = {},
): BustCoordinator {
  return createBustCoordinator({
    contextLineageId: LINEAGE,
    contributors: options.contributors ?? [],
    committedCompartments: env.committedCompartments,
    memoryCoordinator: env.memoryCoordinator,
    contextStore: env.contextStore,
    retirementPort: env.retirementPort,
    ...(options.p4MaxCandidates !== undefined ? { p4MaxCandidates: options.p4MaxCandidates } : {}),
  });
}

test("BUST: requestBust coalesces repeated requests into one rebuild", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      const coordinator = makeCoordinator(env);
      coordinator.requestBust("historian_compartment_committed", {
        schemaId: "iris.bust_evidence.v1",
        receiptIds: ["receipt-1"],
      });
      coordinator.requestBust("historian_compartment_committed", {
        schemaId: "iris.bust_evidence.v1",
        receiptIds: ["receipt-2"],
      });
      coordinator.requestBust("capability_catalog_changed", {
        schemaId: "iris.bust_evidence.v1",
        detail: "catalog v2",
      });
      assert.equal(coordinator.pendingCount(), 2, "same-reason requests coalesce");
      const pending = coordinator.getPendingRequests();
      const historianReq = pending.find((r) => r.reason === "historian_compartment_committed");
      assert.deepEqual(
        [...(historianReq?.evidence.receiptIds ?? [])].sort(),
        ["receipt-1", "receipt-2"],
        "evidence merged",
      );
      const run = await coordinator.runBustIfPending();
      assert.equal(run.ran, true);
      assert.equal(run.published, true);
      assert.equal(coordinator.pendingCount(), 0, "pending consumed after run");
      // 再次运行（无 pending）→ ran=false
      const idle = await coordinator.runBustIfPending();
      assert.equal(idle.ran, false);
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: first rebuild publishes a full P0–P5 generation with live units as P5", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      env.ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "b", sessionId: "session-1" }),
      );
      const coordinator = makeCoordinator(env, {
        contributors: [
          makeContributor("p0", "sys", bustEnvContributorUnits("You are Iris")),
          makeContributor("p1", "persona", bustEnvContributorUnits("persona")),
        ],
      });
      coordinator.requestBust("operator_requested", {
        schemaId: "iris.bust_evidence.v1",
        detail: "manual",
      });
      const run = await coordinator.runBustIfPending();
      assert.equal(run.failed, false);
      assert.ok(run.generation, "generation published");
      assert.ok(run.generation, "generation published");
      const gen = run.generation;
      const [e0, e1, e2, e3, e4, e5] = gen.header.layerEnds;
      assert.equal(e0, 1, "P0 = 1 static unit");
      assert.equal(e1, 2, "P1 = 1 static unit");
      assert.equal(e2, 2, "P2 empty");
      assert.equal(e3, 2, "P3 empty (no compartments)");
      assert.equal(e4, 2, "P4 empty (zero-backend)");
      assert.equal(e5, 4, "P5 = 2 live units");
      assert.deepEqual(
        unitsInLayer(gen, 5).map((u) => u.header.contextUnitId),
        ["input-e1", "assistant-e2"],
        "P5 live units in contextSeq order",
      );
      assert.equal(
        coordinator.getCurrentGeneration()?.header.contextGenerationHash,
        gen.header.contextGenerationHash,
      );
      // watermark 未推进（无 compartment；P4 不推进 retirement）
      const lineage = env.contextStore.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 0);
      assert.equal(lineage?.retiredThroughContextSeq, 0);
      // generation id+hash 绑定
      assert.equal(lineage?.lastBustGenerationId, gen.header.contextGenerationId);
      assert.equal(lineage?.lastBustGenerationHash, gen.header.contextGenerationHash);
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: committed compartment moves covered units from P5 into P3 and advances watermarks", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      env.ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "b", sessionId: "session-1" }),
      );
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e3", content: "c", sessionId: "session-1" }),
      );
      // 模拟 Historian commit：ACK 覆盖 [1..3] → pending_bust；提交 compartment。
      const units = env.contextStore.listUnitsByLineageRange(LINEAGE, 1, 3);
      env.retirementPort.acknowledgeHistorianCommit(receiptFor(1, 3, `compartment-${LINEAGE}-1`));
      commitCompartment(env, 1, units);

      const coordinator = makeCoordinator(env);
      coordinator.requestBust("historian_compartment_committed", {
        schemaId: "iris.bust_evidence.v1",
        receiptIds: ["receipt-1"],
      });
      const run = await coordinator.runBustIfPending();
      assert.equal(run.failed, false);
      assert.ok(run.generation, "generation published");
      const gen = run.generation;
      const [, , , e3, e4, e5] = gen.header.layerEnds;
      assert.equal(e3, e4, "P3 present, P4 empty");
      assert.equal(e3, 1, "P3 = 1 compartment unit");
      assert.equal(e5, 1, "P5 empty — covered live units left P5");
      assert.deepEqual(
        unitsInLayer(gen, 3).map((u) => u.header.contextUnitId),
        [`compartment-${LINEAGE}-1`],
      );
      // watermark 推进到 compartment 覆盖的边界（=3）
      const lineage = env.contextStore.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 3);
      assert.equal(lineage?.retiredThroughContextSeq, 3);
      // covered units 的 lifecycle：pending_bust → retired（represented=retired）
      const after = env.contextStore.listUnitsByLineageRange(LINEAGE, 1, 3);
      for (const unit of after) {
        assert.equal(unit.lifecycleState, "retired", `unit ${unit.contextUnitId} retired`);
      }
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: units committed after representation stay live (P5) on the next rebuild", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      env.ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "b", sessionId: "session-1" }),
      );
      const units12 = env.contextStore.listUnitsByLineageRange(LINEAGE, 1, 2);
      env.retirementPort.acknowledgeHistorianCommit(receiptFor(1, 2, `compartment-${LINEAGE}-1`));
      commitCompartment(env, 1, units12);
      const coordinator = makeCoordinator(env);
      coordinator.requestBust("historian_compartment_committed", {
        schemaId: "iris.bust_evidence.v1",
        receiptIds: ["receipt-1"],
      });
      await coordinator.runBustIfPending();
      // 新 committed units 4-5（在 compartment 之外）→ 下一次 rebuild 仍在 P5。
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e4", content: "d", sessionId: "session-1" }),
      );
      env.ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e5", content: "e", sessionId: "session-1" }),
      );
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      const run = await coordinator.runBustIfPending();
      assert.equal(run.failed, false);
      assert.ok(run.generation, "generation published");
      const gen = run.generation;
      assert.deepEqual(
        unitsInLayer(gen, 5).map((u) => u.header.contextUnitId),
        ["input-e4", "assistant-e5"],
        "units after the represented boundary stay live",
      );
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: failure is fail-closed — no partial generation, no watermark advance, no previous fallback", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      let throwNow = false;
      const flaky: ContextSourceContributor = {
        layer: "p0",
        sourceId: "flaky",
        sourceRevision: "1",
        sourceHash: "h",
        project: () => {
          if (throwNow) {
            throw new Error("contributor exploded during freeze");
          }
          return bustEnvContributorUnits("ok");
        },
      };
      const coordinator = makeCoordinator(env, { contributors: [flaky] });
      // 第一次成功发布 G1
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      const first = await coordinator.runBustIfPending();
      assert.equal(first.published, true);
      assert.ok(coordinator.getCurrentGeneration());
      const lineageBefore = env.contextStore.getLineageByLineageId(LINEAGE);
      assert.equal(lineageBefore?.representedThroughContextSeq, 0);

      // 第二次 BUST 失败：fail-closed —— 旧 generation 不被新请求使用。
      throwNow = true;
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      const second = await coordinator.runBustIfPending();
      assert.equal(second.failed, true);
      assert.equal(second.published, false);
      assert.equal(second.generation, null);
      assert.equal(
        coordinator.getCurrentGeneration(),
        null,
        "no previous-generation fallback after failed BUST",
      );
      const lineageAfter = env.contextStore.getLineageByLineageId(LINEAGE);
      assert.equal(
        lineageAfter?.representedThroughContextSeq,
        0,
        "watermark not advanced on failure",
      );
      assert.equal(lineageAfter?.retiredThroughContextSeq, 0);
      // 恢复后可以再次成功发布（无 LKG，只重建）
      throwNow = false;
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      const third = await coordinator.runBustIfPending();
      assert.equal(third.published, true);
      assert.ok(coordinator.getCurrentGeneration());
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: P4 zero-backend → empty P4; ready backend → projected P4; P4 never advances retirement", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      const coordinator = makeCoordinator(env);
      // zero-backend
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      let run = await coordinator.runBustIfPending();
      assert.equal(run.failed, false);
      assert.ok(run.generation, "generation published");
      let gen = run.generation;
      assert.equal(
        gen.header.layerEnds[3] ?? 0,
        gen.header.layerEnds[4] ?? 0,
        "P4 empty (zero-backend)",
      );

      // ready backend → P4 投影
      const adapter: MemoryServiceAdapter = {
        serviceId: "fake",
        epoch: "epoch-1",
        revision: "rev-1",
        status: () => "ready",
        recall: async (): Promise<MemoryRecallResult> => ({
          snapshotId: "snap-1",
          revision: "rev-1",
          status: "ready",
          candidates: [
            {
              recollectionId: "m1",
              statement: "remembered fact",
              sourceTrust: "observed",
              relevanceScore: 0.8,
            },
          ],
        }),
      };
      env.memoryCoordinator.mount(adapter);
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      run = await coordinator.runBustIfPending();
      assert.equal(run.failed, false);
      assert.ok(run.generation, "generation published");
      gen = run.generation;
      assert.equal(
        (gen.header.layerEnds[4] ?? 0) - (gen.header.layerEnds[3] ?? 0),
        1,
        "P4 = 1 recollection unit",
      );
      const p4 = unitsInLayer(gen, 4)[0];
      assert.equal(p4?.header.semanticSchemaId, "iris.semantic.recollection.v1");
      assert.equal((p4?.semanticContent as Record<string, unknown>)["status"], "available");
      // P4 不推进 retirement（无 compartment；watermark 保持 0）
      const lineage = env.contextStore.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 0);
      assert.equal(lineage?.retiredThroughContextSeq, 0);
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: memory unavailable → P4 explicit marker in the published generation", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      const adapter: MemoryServiceAdapter = {
        serviceId: "fake-down",
        epoch: "epoch-1",
        revision: "rev-1",
        status: () => "unavailable",
        recall: async (): Promise<MemoryRecallResult> => ({
          status: "unavailable",
          candidates: [],
        }),
      };
      env.memoryCoordinator.mount(adapter);
      const coordinator = makeCoordinator(env);
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      const run = await coordinator.runBustIfPending();
      assert.equal(run.failed, false, "memory unavailability does not fail the BUST");
      assert.ok(run.generation, "generation published");
      const gen = run.generation;
      assert.equal(
        (gen.header.layerEnds[4] ?? 0) - (gen.header.layerEnds[3] ?? 0),
        1,
        "P4 = 1 explicit marker",
      );
      const marker = unitsInLayer(gen, 4)[0];
      assert.equal((marker?.semanticContent as Record<string, unknown>)["status"], "unavailable");
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: contributor invalidation seam submits a canonical BUST request", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      const coordinator = makeCoordinator(env, {
        contributors: [makeContributor("p2", "catalog", bustEnvContributorUnits("catalog"))],
      });
      const hit = coordinator.invalidateSource("catalog", "skill manifest changed");
      assert.equal(hit, true);
      assert.equal(coordinator.pendingCount(), 1);
      const pending = coordinator.getPendingRequests()[0];
      assert.equal(pending?.reason, "source_invalidation");
      const miss = coordinator.invalidateSource("unknown-source");
      assert.equal(miss, false);
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("BUST: failed rebuild keeps previous generation unusable even without a new request", async () => {
  const dir = tempDir();
  try {
    const env = openBustEnvironment(dir, LINEAGE);
    try {
      env.ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "a", sessionId: "session-1" }),
      );
      const coordinator = makeCoordinator(env);
      coordinator.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      await coordinator.runBustIfPending();
      assert.ok(coordinator.getCurrentGeneration());
      // 直接让 memory recall 抛错不会让 BUST 失败（unavailable 是显式 marker）；
      // 这里通过一个抛错的 contributor 制造失败。
      const throwing: ContextSourceContributor = {
        layer: "p1",
        sourceId: "boom",
        sourceRevision: "1",
        sourceHash: "h",
        project: () => {
          throw new Error("boom");
        },
      };
      const coordinator2 = createBustCoordinator({
        contextLineageId: LINEAGE,
        contributors: [throwing],
        committedCompartments: env.committedCompartments,
        memoryCoordinator: env.memoryCoordinator,
        contextStore: env.contextStore,
        retirementPort: env.retirementPort,
      });
      coordinator2.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
      const run = await coordinator2.runBustIfPending();
      assert.equal(run.failed, true);
      assert.equal(coordinator2.getCurrentGeneration(), null);
      // 旧 coordinator 的 generation 保持其自身状态（fail-closed 是 per-coordinator）
      assert.ok(coordinator.getCurrentGeneration());
    } finally {
      env.contextStore.close();
      env.historianStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
