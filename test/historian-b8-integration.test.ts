/**
 * Historian Feature B8（Phase D）—— 端到端集成测试。
 *
 * 真实 ContextStore（context.db）+ ContextIngest → ContextHistoryReadPort →
 * HistorianManager（historian.db）→ commit → receipt → Context ACK
 * （compartmentalized_pending_bust）→ outbox delivery（fake Memory client）。
 *
 * 证明 v29 commit protocol 的完整闭环，且无 Pi / Graphiti 依赖。
 */
import test from "node:test";

import assert from "node:assert/strict";

import { ContextStore } from "../src/context/context-store.js";
import { ContextAdmission } from "../src/context/context-admission.js";
import { DSH_MESSAGE_REF_V1_SCHEMA_ID } from "../src/contracts/context-unit.js";
import { createContextHistoryReadPort } from "../src/context/history-read-port.js";
import { createContextRetirementPort } from "../src/context/context-retirement-port.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import {
  HistorianManager,
  type MemoryDeliveryClientPort,
} from "../src/historian/historian-manager.js";
import type { MemoryDeliveryReceipt } from "../src/historian/historian-publication.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";
import { join } from "node:path";

const LINEAGE = "identity-integration";

/** runtime-origin 语义 schema（contentSchemaId → kind 判别）。 */
const KIND_TO_SCHEMA: Record<"user" | "assistant" | "tool_result", string> = {
  user: "iris.semantic.context_message.user.v1",
  assistant: "iris.semantic.context_message.assistant.v1",
  tool_result: "iris.semantic.context_message.tool_result.v1",
};

/**
 * 经统一 ContextUnit admission 接纳一条 runtime-origin 消息（Feature 5：
 * Historian 只消费 v3 ContextUnit，legacy ContextIngest 不再驱动 Historian）。
 */
function admitMessage(
  admission: ContextAdmission,
  sessionId: string,
  messageId: string,
  kind: "user" | "assistant" | "tool_result",
  content: string,
): void {
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
  admission.admit({
    sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId, messageId },
    contentSchemaId: KIND_TO_SCHEMA[kind],
    content: contentByKind[kind] as never,
    runtimeSessionId: sessionId,
  });
}

function openContext(dir: string): { store: ContextStore; admission: ContextAdmission } {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  const admission = new ContextAdmission(store);
  return { store, admission };
}

test("B8: full pipeline — trigger → commit → receipt → ACK → outbox delivery", async () => {
  const dir = tempDir();
  try {
    const { store: contextStore, admission } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      // Admit committed Context units (user + assistant + tool result) via the
      // unified ContextUnit admission path (Historian consumes v3 only).
      admitMessage(admission, "session-1", "e1", "user", "hello iris");
      admitMessage(admission, "session-1", "e2", "assistant", "hi there");
      admitMessage(admission, "session-1", "e3", "tool_result", "ok");
      const before = contextStore.listUnits("session-1");
      assert.ok(before.length >= 3, "committed units exist");
      assert.equal(before[0]?.lifecycleState, "committed");

      const historyPort = createContextHistoryReadPort(contextStore);
      const retirementPort = createContextRetirementPort(contextStore);

      // Fake Memory client: returns a receipt bound to the exact publication.
      let deliveredPayload: unknown = null;
      const memoryClient: MemoryDeliveryClientPort = {
        async deliverPublication(payload: unknown) {
          deliveredPayload = payload;
          const envelope = payload as { publicationId?: string; outputHash?: string };
          const receipt: MemoryDeliveryReceipt = {
            receiptId: "mem-r1",
            publicationId: envelope.publicationId ?? "",
            canonicalPayloadHash: envelope.outputHash ?? "",
            contractVersion: "0.3.0",
          };
          return { ok: true, receipt };
        },
      };

      const manager = new HistorianManager({
        store: historianStore,
        historyPort,
        retirementPort,
        memoryClient,
        maxQueuedJobs: 8,
        nowMs: () => 1_000,
      });

      // Trigger incremental + pump.
      const triggered = await manager.triggerIncremental("session-1");
      assert.equal(triggered, true, "incremental triggered");
      await manager.pumpOnce();

      const health = manager.health();
      assert.equal(health.queue.completed, 1, "one job completed");
      assert.equal(health.publicationCount, 1);
      assert.equal(health.outboxPending, 1);
      assert.equal(health.cursor.processedThroughContextSeq, 3, "cursor advanced to batch ceiling");

      // Commit protocol: covered units marked compartmentalized_pending_bust.
      const after = contextStore.listUnits("session-1");
      for (const unit of after) {
        if (unit.contextSeq <= 3) {
          assert.equal(
            unit.lifecycleState,
            "compartmentalized_pending_bust",
            `unit ${unit.contextSeq} acked → compartmentalized_pending_bust`,
          );
        }
      }

      // Publication committed + outbox pending with provider-neutral payload.
      const outbox = historianStore
        .raw()
        .prepare("SELECT payload_json FROM publication_outbox")
        .all() as unknown as Array<{ payload_json: string }>;
      const payload = JSON.parse(outbox[0]?.payload_json ?? "{}") as Record<string, unknown>;
      assert.equal(payload["schemaId"], "iris.memory_publication.v1");
      assert.ok(payload["observations"], "provider-neutral observations present");
      assert.ok(!JSON.stringify(payload).toLowerCase().includes("graphiti"));

      // Outbox delivery: claim → deliver → delivered.
      const metrics = await manager.drainOutbox(10);
      assert.equal(metrics.accepted, 1);
      assert.equal(metrics.claimed, 1);
      assert.equal(manager.health().outboxPending, 0, "outbox delivered");
      assert.ok(deliveredPayload !== null, "memory client received the publication");

      // Idempotency: a second trigger with nothing new is a no-op.
      assert.equal(
        await manager.triggerIncremental("session-1"),
        false,
        "nothing new after commit",
      );
      manager.close();
    } finally {
      historianStore.close();
      contextStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("B8: recover() replays un-acked committed receipts (no duplicate publication)", async () => {
  const dir = tempDir();
  try {
    const { store: contextStore, admission } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      admitMessage(admission, "session-1", "e1", "user", "hello");
      admitMessage(admission, "session-1", "e2", "assistant", "hi");
      const historyPort = createContextHistoryReadPort(contextStore);
      const retirementPort = createContextRetirementPort(contextStore);
      const manager = new HistorianManager({
        store: historianStore,
        historyPort,
        retirementPort,
        maxQueuedJobs: 8,
        nowMs: () => 1_000,
      });

      assert.equal(await manager.triggerIncremental("session-1"), true);
      await manager.pumpOnce();
      // 正常路径已 ACK。模拟"commit 后未 ACK"：把 batch 的 acked_at 清空。
      historianStore
        .raw()
        .prepare("UPDATE historian_batches SET acked_at = NULL WHERE acked_at IS NOT NULL")
        .run();
      // 同时把 Context 侧单元重置回 committed（模拟重启前 ACK 未持久化）。
      contextStore
        .raw()
        .prepare(
          "UPDATE context_units SET lifecycle_state = 'committed' WHERE context_lineage_id = ?",
        )
        .run(LINEAGE);

      // 新 manager 实例（模拟重启）：recover 重放未 ACK receipt。
      const manager2 = new HistorianManager({
        store: historianStore,
        historyPort,
        retirementPort,
        maxQueuedJobs: 8,
        nowMs: () => 2_000,
      });
      await manager2.recover();
      const units = contextStore.listUnits("session-1");
      assert.equal(
        units[0]?.lifecycleState,
        "compartmentalized_pending_bust",
        "replayed receipt re-marks covered units",
      );
      assert.equal(manager2.health().publicationCount, 1, "no duplicate publication on replay");
      manager2.close();
      manager.close();
    } finally {
      historianStore.close();
      contextStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("B8: outbox delivery rejects a receipt with WRONG canonicalPayloadHash (binding fail-closed)", async () => {
  const dir = tempDir();
  try {
    const { store: contextStore, admission } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      admitMessage(admission, "session-1", "e1", "user", "hello");
      admitMessage(admission, "session-1", "e2", "assistant", "hi");
      const historyPort = createContextHistoryReadPort(contextStore);
      const retirementPort = createContextRetirementPort(contextStore);

      // Fake Memory client returns a receipt with the CORRECT publicationId but
      // a WRONG canonicalPayloadHash — must NOT authorize delivered.
      const memoryClient: MemoryDeliveryClientPort = {
        async deliverPublication(payload: unknown) {
          const envelope = payload as { publicationId?: string; outputHash?: string };
          return {
            ok: true,
            receipt: {
              receiptId: "mem-wrong-hash",
              publicationId: envelope.publicationId ?? "",
              canonicalPayloadHash:
                "0000000000000000000000000000000000000000000000000000000000000000",
              contractVersion: "0.3.0",
            } satisfies MemoryDeliveryReceipt,
          };
        },
      };

      const manager = new HistorianManager({
        store: historianStore,
        historyPort,
        retirementPort,
        memoryClient,
        maxQueuedJobs: 8,
        nowMs: () => 1_000,
      });
      assert.equal(await manager.triggerIncremental("session-1"), true);
      await manager.pumpOnce();

      const metrics = await manager.drainOutbox(10);
      assert.equal(metrics.rejected, 1, "wrong-hash receipt must be rejected");
      assert.equal(metrics.accepted, 0, "nothing accepted");

      // The publication must NOT be marked delivered (binding not authorized).
      const outboxRow = historianStore
        .raw()
        .prepare("SELECT payload_json FROM publication_outbox LIMIT 1")
        .get() as unknown as { payload_json: string } | undefined;
      assert.ok(outboxRow !== undefined);
      const envelope = JSON.parse(outboxRow.payload_json) as { publicationId?: string };
      const pub = historianStore
        .raw()
        .prepare("SELECT state, delivered_at FROM publications WHERE publication_id = ?")
        .get(envelope.publicationId ?? "") as
        { state: string; delivered_at: string | null } | undefined;
      assert.ok(pub !== undefined);
      assert.notEqual(pub.state, "delivered");
      assert.equal(pub.delivered_at, null);
      manager.close();
    } finally {
      historianStore.close();
      contextStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("B8: outbox delivery rejects a receipt with UNKNOWN contractVersion (binding fail-closed)", async () => {
  const dir = tempDir();
  try {
    const { store: contextStore, admission } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      admitMessage(admission, "session-1", "e1", "user", "hello");
      admitMessage(admission, "session-1", "e2", "assistant", "hi");
      const historyPort = createContextHistoryReadPort(contextStore);
      const retirementPort = createContextRetirementPort(contextStore);

      const memoryClient: MemoryDeliveryClientPort = {
        async deliverPublication(payload: unknown) {
          const envelope = payload as { publicationId?: string; outputHash?: string };
          return {
            ok: true,
            receipt: {
              receiptId: "mem-bad-version",
              publicationId: envelope.publicationId ?? "",
              canonicalPayloadHash: envelope.outputHash ?? "",
              contractVersion: "9.9.9",
            } satisfies MemoryDeliveryReceipt,
          };
        },
      };

      const manager = new HistorianManager({
        store: historianStore,
        historyPort,
        retirementPort,
        memoryClient,
        maxQueuedJobs: 8,
        nowMs: () => 1_000,
      });
      assert.equal(await manager.triggerIncremental("session-1"), true);
      await manager.pumpOnce();

      const metrics = await manager.drainOutbox(10);
      assert.equal(metrics.rejected, 1, "unknown contractVersion receipt must be rejected");
      assert.equal(metrics.accepted, 0);
      manager.close();
    } finally {
      historianStore.close();
      contextStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("B8: all-exclude batch advances the cursor (no stall) and later include units process normally", async () => {
  const dir = tempDir();
  try {
    const { store: contextStore, admission } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      // Admit two units, then force both to historian_disposition='exclude'
      // (e.g. soft-cap overflow / telemetry) → an all-exclude window.
      // NOTE（Feature 5）：v3（ContextUnit）canonical content-hash basis 不含
      // disposition —— disposition 是 sidecar 状态，不属于 immutable Unit，
      // 所以直接 UPDATE disposition 即可，无需重算 content_hash。
      admitMessage(admission, "session-1", "e1", "user", "telemetry-a");
      admitMessage(admission, "session-1", "e2", "assistant", "telemetry-b");
      contextStore
        .raw()
        .prepare(
          "UPDATE context_units SET disposition = 'exclude' WHERE context_lineage_id = ? AND context_seq <= 2",
        )
        .run(LINEAGE);

      const historyPort = createContextHistoryReadPort(contextStore);
      const retirementPort = createContextRetirementPort(contextStore);
      const manager = new HistorianManager({
        store: historianStore,
        historyPort,
        retirementPort,
        maxQueuedJobs: 8,
        nowMs: () => 1_000,
      });

      assert.equal(await manager.triggerIncremental("session-1"), true);
      await manager.pumpOnce();

      // Cursor MUST advance over the all-exclude window (no permanent stall).
      assert.equal(
        manager.health().cursor.processedThroughContextSeq,
        2,
        "cursor advanced over all-exclude window",
      );
      // No Compartment / Publication / outbox rows were produced.
      const compartmentCount = (
        historianStore.raw().prepare("SELECT COUNT(*) AS c FROM compartments").get() as {
          c: number;
        }
      ).c;
      const publicationCount = (
        historianStore.raw().prepare("SELECT COUNT(*) AS c FROM publications").get() as {
          c: number;
        }
      ).c;
      const outboxCount = (
        historianStore.raw().prepare("SELECT COUNT(*) AS c FROM publication_outbox").get() as {
          c: number;
        }
      ).c;
      assert.equal(compartmentCount, 0, "no compartment for all-exclude window");
      assert.equal(publicationCount, 0, "no publication for all-exclude window");
      assert.equal(outboxCount, 0, "no outbox row for all-exclude window");
      // Batch row exists in 'skipped' state.
      const batchState = (
        historianStore.raw().prepare("SELECT state FROM historian_batches LIMIT 1").get() as {
          state: string;
        }
      ).state;
      assert.equal(batchState, "skipped");

      // A later include unit must now process normally (lineage not stalled).
      admitMessage(admission, "session-1", "e3", "user", "real user message");
      assert.equal(await manager.triggerIncremental("session-1"), true);
      await manager.pumpOnce();
      assert.equal(
        manager.health().cursor.processedThroughContextSeq,
        3,
        "later include unit processed",
      );
      assert.equal(manager.health().publicationCount, 1, "one publication for the include unit");
      manager.close();
    } finally {
      historianStore.close();
      contextStore.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
