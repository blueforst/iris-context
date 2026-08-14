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
import { ContextIngest } from "../src/context/context-ingest.js";
import {
  computeContextMessageUnitContentHashV1,
  type JsonValue,
} from "../src/contracts/context-v27.js";
import { createContextHistoryReadPort } from "../src/context/history-read-port.js";
import { createContextRetirementPort } from "../src/context/context-retirement-port.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import {
  HistorianManager,
  type MemoryDeliveryClientPort,
} from "../src/historian/historian-manager.js";
import type { MemoryDeliveryReceipt } from "../src/historian/historian-publication.js";
import {
  assistantInput,
  cleanupDir,
  makeLineageInput,
  tempDir,
  toolResultInput,
  userInput,
} from "./helpers/context-fixtures.js";
import { join } from "node:path";

const LINEAGE = "identity-integration";

function openContext(dir: string): { store: ContextStore; ingest: ContextIngest } {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  const ingest = new ContextIngest(store, LINEAGE);
  return { store, ingest };
}

test("B8: full pipeline — trigger → commit → receipt → ACK → outbox delivery", async () => {
  const dir = tempDir();
  try {
    const { store: contextStore, ingest } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      // Ingest committed Context units (user + assistant + tool result).
      ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "hello iris", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "hi there", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(
        toolResultInput({ eventId: "e3", text: "ok", sessionId: "session-1" }),
      );
      const before = ingest.listUnits("session-1");
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
      const after = ingest.listUnits("session-1");
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
    const { store: contextStore, ingest } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "hello", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "hi", sessionId: "session-1" }),
      );
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
      const units = ingest.listUnits("session-1");
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
    const { store: contextStore, ingest } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "hello", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "hi", sessionId: "session-1" }),
      );
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
    const { store: contextStore, ingest } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "hello", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "hi", sessionId: "session-1" }),
      );
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
    const { store: contextStore, ingest } = openContext(dir);
    const historianStore = HistorianStore.open({
      databasePath: join(dir, "historian.db"),
      nowMs: () => 1_000,
    });
    try {
      // Ingest two units, then force both to historian_disposition='exclude'
      // (e.g. soft-cap overflow / telemetry) → an all-exclude window.
      // NOTE: disposition is part of the canonical content-hash basis, so a
      // legitimate disposition transition must recompute content_hash — the
      // store fails closed otherwise (tamper detection, correctly).
      ingest.ingestRuntimeEvent(
        userInput({ eventId: "e1", content: "telemetry-a", sessionId: "session-1" }),
      );
      ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "telemetry-b", sessionId: "session-1" }),
      );
      const unitRows = contextStore
        .raw()
        .prepare(
          "SELECT context_seq, semantic_schema_id, unit_type, payload, derivation_refs FROM context_units WHERE context_lineage_id = ? AND context_seq <= 2",
        )
        .all(LINEAGE) as unknown as Array<{
        context_seq: number;
        semantic_schema_id: string;
        unit_type: string;
        payload: string;
        derivation_refs: string | null;
      }>;
      const KIND_FROM_UNIT_TYPE: Record<string, "user" | "assistant" | "tool_result"> = {
        input: "user",
        assistant: "assistant",
        tool_result: "tool_result",
      };
      for (const row of unitRows) {
        const content = JSON.parse(row.payload) as JsonValue;
        const refs =
          row.derivation_refs === null
            ? { schemaId: "iris.semantic_derivation_refs.v1" as const }
            : (JSON.parse(row.derivation_refs) as Parameters<
                typeof computeContextMessageUnitContentHashV1
              >[0]["derivationRefs"]);
        const hash = computeContextMessageUnitContentHashV1({
          semanticSchemaId: row.semantic_schema_id,
          kind: KIND_FROM_UNIT_TYPE[row.unit_type] ?? "user",
          historianDisposition: "exclude",
          derivationRefs: refs,
          semanticContent: content,
        });
        contextStore
          .raw()
          .prepare(
            "UPDATE context_units SET disposition = 'exclude', content_hash = ? WHERE context_lineage_id = ? AND context_seq = ?",
          )
          .run(hash, LINEAGE, row.context_seq);
      }

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
      ingest.ingestRuntimeEvent(
        userInput({ eventId: "e3", content: "real user message", sessionId: "session-1" }),
      );
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
