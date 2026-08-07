/**
 * R3-P4 移植说明：本文件从已通过审查的
 * `agent/r2-product-parity-fix-r3-historian` 分支（commit 5b94db7）的
 * `test/historian-b8-integration.test.ts` 移植。
 *
 * 适配点：无签名变更——HistorianManager / HistorianStore / SessionHistoryReadPort
 * 在 main 上均原样存在，`triggerIncremental` / `enqueueWrapup` / `recover` /
 * `pumpOnce` / `drainOutbox` / `health` / `close` / `enqueueRecomp` API 一致。
 * 代码逻辑与分支保持一致（R3-P4 的 wrapup 单事务 + closing 状态机变更已在
 * Exit Gate 测试中另行验证，本文件保持分支断言不变）。
 *
 * Feature B8 — R3 product integration、recovery 与 Exit Gate 路径。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

import { HistorianManager } from "../src/historian/historian-manager.js";
import { HistorianStore } from "../src/historian/historian-store.js";
import { FakeMemoryClient } from "../src/historian/memory-client.js";
import { SessionHistoryReadPort } from "../src/historian/history-read-port.js";
import type { ContextHistoryReadPort } from "../src/context/history-read-port.js";

/** iris_agent#45: production Historian cannot publish without the Context
 * read/claim port — tests wire a stub port with committed units. */
function stubHistoryPort(): ContextHistoryReadPort {
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: 0,
        representedThroughEntrySeq: 0,
        m0ContentHash: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    listUnitsForHistorian() {
      return [];
    },
    listUnitsForHistorianByEntrySeq(_r: string, fromEntrySeq: number, toEntrySeq: number) {
      const units: import("../src/historian/anti-echo.js").HistorianUnitView[] = [];
      for (let seq = fromEntrySeq; seq <= toEntrySeq; seq++) {
        units.push({
          contextUnitId: `unit-${seq}`,
          contextSeq: seq,
          runtimeEventId: `evt-${seq}`,
          unitType: "input",
          disposition: "include",
          contentHash: "b".repeat(64),
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
        });
      }
      return units;
    },
    lineageId() {
      return "identity-b8b9";
    },
  };
}

const SESSION = "iris-runtime-2026-08-01-1";

function u(id: string, parentId: string | null, text = "hello", ts = 1): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: text, timestamp: ts },
  } as unknown as SessionTreeEntry;
}

function c(id: string, parentId: string, ts = 2): SessionTreeEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    customType: "iris_input_meta",
    content: "<iris-input-meta/>",
    display: false,
  } as unknown as SessionTreeEntry;
}

function assistantText(id: string, parentId: string, text: string, ts = 3): SessionTreeEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: ts,
    },
  } as unknown as SessionTreeEntry;
}

function managerFixture(entries: SessionTreeEntry[]): {
  manager: HistorianManager;
  store: HistorianStore;
  dir: string;
  mutable: SessionTreeEntry[];
} {
  const dir = mkdtempSync(join(tmpdir(), "iris-b8-"));
  const store = HistorianStore.open({ databasePath: join(dir, "historian.db") });
  const mutable = [...entries];
  const port = new SessionHistoryReadPort({ readRawEntries: async () => mutable });
  const manager = new HistorianManager({
    store,
    readPort: port,
    modelProviderProfile: "opencode/deepseek-v4-flash",
    historyPort: stubHistoryPort(),
    // iris_agent#46: without a client no outbox row can be marked delivered;
    // the B8 delivery assertions need a REAL receipt-capable client.
    memoryClient: new FakeMemoryClient(),
  });
  return { manager, store, dir, mutable };
}

test("B8: active incremental trigger", async () => {
  const { manager, store, dir } = managerFixture([
    u("u-1", null, "please read the file"),
    c("c-1", "u-1"),
    assistantText("a-1", "c-1", "I will read it."),
  ]);
  try {
    await manager.triggerIncremental(SESSION);
    assert.ok(manager.getQueue().pendingCount() >= 1, "highest job enqueued");
    await manager.pumpOnce();
    // A publication + outbox row exist; the cursor advanced.
    assert.equal(store.countPublications(), 1, "one publication committed");
    const outbox = store
      .raw()
      .prepare("SELECT COUNT(*) AS n FROM publication_outbox WHERE state = 'pending'")
      .get() as { n: number };
    assert.equal(outbox.n, 1, "one pending outbox row");
    assert.ok(
      (store.getSessionState(SESSION)?.processedThroughEntrySeq ?? 0) > 0,
      "cursor advanced",
    );
    // Delivery loop drains it.
    const delivered = await manager.drainOutbox();
    assert.equal(delivered.claimed, 1);
    assert.equal(delivered.accepted, 1, "real receipt authorizes delivered");
    assert.equal(store.countOutboxPending(), 0, "outbox drained to delivered");
    const health = manager.health();
    assert.equal(health.ready, true);
    assert.equal(health.publicationCount, 1);
    assert.equal(health.outboxPending, 0);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: incremental growth — a second trigger commits a second publication (no stall)", async () => {
  const { manager, store, dir, mutable } = managerFixture([
    u("u-1", null, "first"),
    c("c-1", "u-1"),
  ]);
  try {
    await manager.triggerIncremental(SESSION);
    await manager.pumpOnce();
    assert.equal(store.countPublications(), 1);
    // Session grows.
    mutable.push(u("u-2", "c-1", "second"), c("c-2", "u-2"));
    await manager.triggerIncremental(SESSION);
    await manager.pumpOnce();
    assert.equal(store.countPublications(), 2, "growing session processed continuously");
    assert.ok((store.getSessionState(SESSION)?.processedThroughEntrySeq ?? 0) >= 2);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: rollover wrapup — enqueued at normal priority, rollover does NOT wait", async () => {
  const { manager, store, dir } = managerFixture([
    u("u-1", null, "please remember: prefer short replies"),
    c("c-1", "u-1"),
  ]);
  try {
    // Fire-and-forget: the wrapup enqueue returns immediately.
    const enqueued = await manager.enqueueWrapup(SESSION);
    assert.equal(enqueued, true, "wrapup enqueued (fire-and-forget)");
    assert.equal(manager.getQueue().pendingCount(), 1);
    // Rollover does NOT wait: we can immediately do other work.
    await manager.pumpOnce();
    const state = store.getSessionState(SESSION);
    assert.ok(
      state?.status === "closed" || state?.status === "closed_incomplete",
      `old Session finalized (${state?.status})`,
    );
    assert.equal(store.listContinuitySnapshots(SESSION).length, 1, "continuity snapshot persisted");
    // The new Session has a FRESH lineage.
    assert.equal(store.listContinuitySnapshots("iris-runtime-2026-08-02-1").length, 0);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: closed Session retry at startup (recover re-enqueues low)", async () => {
  const { manager, store, dir, mutable } = managerFixture([
    u("u-1", null, "hello"),
    c("c-1", "u-1"),
    assistantText("a-1", "c-1", "reply"),
  ]);
  try {
    // Close the session via wrapup (drains everything).
    await manager.enqueueWrapup(SESSION);
    await manager.pumpOnce();
    assert.equal(manager.getQueue().pendingCount(), 0);
    // Simulated RESTART: a new manager over the SAME durable store + data
    // root recovers the closed session (the Session has since grown).
    mutable.push(u("u-2", "a-1", "new after restart"), c("c-2", "u-2"));
    const port = new SessionHistoryReadPort({ readRawEntries: async () => mutable });
    const restarted = new HistorianManager({
      store,
      readPort: port,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "opencode/deepseek-v4-flash",
    });
    await restarted.recover();
    assert.ok(restarted.getQueue().pendingCount() >= 1, "closed session retried at low priority");
    await restarted.pumpOnce();
    assert.equal(restarted.getQueue().pendingCount(), 0, "retry drained");
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: shutdown closes the store (no leak) and health reports drained state", async () => {
  const { manager, store, dir } = managerFixture([u("u-1", null, "hello"), c("c-1", "u-1")]);
  try {
    await manager.triggerIncremental(SESSION);
    await manager.pumpOnce();
    assert.equal(store.countPublications(), 1, "store committed before close");
    assert.equal(manager.health().ready, true);
    manager.close();
    // A second close is idempotent.
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: SIGKILL-style reopen — a fully committed publication survives (crash window)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-b8-crash-"));
  const dbPath = join(dir, "historian.db");
  const entries = [u("u-1", null, "hello"), c("c-1", "u-1"), assistantText("a-1", "c-1", "reply")];
  try {
    const store = HistorianStore.open({ databasePath: dbPath });
    const port = new SessionHistoryReadPort({ readRawEntries: async () => entries });
    const manager = new HistorianManager({
      store,
      readPort: port,
      modelProviderProfile: "m",
      historyPort: stubHistoryPort(),
    });
    await manager.triggerIncremental(SESSION);
    await manager.pumpOnce();
    manager.close(); // simulated crash boundary: committed state is durable

    // Reopen (restart): the committed publication + cursor survive.
    const reopened = HistorianStore.open({ databasePath: dbPath });
    try {
      assert.equal(reopened.countPublications(), 1, "publication survived the crash/restart");
      const state = reopened.getSessionState(SESSION);
      assert.ok((state?.processedThroughEntrySeq ?? 0) > 0, "cursor survived");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: recomp maintenance enqueues at manual priority (lowest)", async () => {
  const { manager, store, dir } = managerFixture([u("u-1", null, "hello"), c("c-1", "u-1")]);
  try {
    await manager.enqueueRecomp(SESSION);
    const job = manager.getQueue().peek();
    assert.equal(job?.priority, "manual", "recomp is manual priority");
    await manager.pumpOnce();
    assert.equal(store.countPublications(), 1, "recomp committed");
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// F5 (iris_agent#42): a durable `closing` transition must ALWAYS have a
// guaranteed finalization path. These tests drive the real manager/store/queue
// (not queue internals only) and assert the durable state machine.
test("F5: wrapup racing a RUNNING incremental still finalizes (no closing wedge)", async () => {
  const { manager, store, dir } = managerFixture([
    u("u-1", null, "please read the file"),
    c("c-1", "u-1"),
    assistantText("a-1", "c-1", "I will read it."),
    u("u-2", "a-1", "thanks", 5),
    c("c-2", "u-2", 6),
  ]);
  try {
    // Enqueue a highest incremental and TAKE it (simulating it is running).
    await manager.triggerIncremental(SESSION);
    const queue = manager.getQueue();
    const running = queue.take();
    assert.equal(running?.priority, "highest", "incremental is running");

    // Rollover requests wrapup while the incremental is still running.
    const wrapped = await manager.enqueueWrapup(SESSION);
    assert.equal(wrapped, true, "wrapup must be accepted while a job runs");
    assert.equal(queue.successorCount(), 1, "terminal successor registered");
    // Durable state already says closing.
    assert.equal(store.getSessionState(SESSION)?.status, "closing");

    // The incremental finishes; the wrapup successor must run and finalize.
    queue.finish(true);
    await manager.pumpOnce();
    assert.equal(queue.successorCount(), 0, "successor consumed");
    const finalState = store.getSessionState(SESSION);
    assert.ok(
      finalState?.status === "closed" || finalState?.status === "closed_incomplete",
      `session must leave closing, got ${finalState?.status}`,
    );
    assert.equal(
      store.listContinuitySnapshots(SESSION, 10).length,
      1,
      "exactly one ContinuitySnapshot",
    );
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: recover() re-enqueues closing sessions (durable intent survives crash)", async () => {
  const { manager, store, dir } = managerFixture([
    u("u-1", null, "please read the file"),
    c("c-1", "u-1"),
    assistantText("a-1", "c-1", "I will read it."),
  ]);
  try {
    // Persist closing WITHOUT any queue job (crash after closing persist,
    // before successor registration / finalizer ran).
    await manager.enqueueWrapup(SESSION);
    const queue = manager.getQueue();
    // Simulate the lost successor: drain pending without running the finalizer
    // and without the durable state reaching closed.
    while (queue.pendingCount() > 0) {
      queue.take();
      queue.finish(true);
    }
    assert.equal(store.getSessionState(SESSION)?.status, "closing", "durable closing remains");

    // Restart: a fresh manager over the SAME store recovers the closing session.
    const port = new SessionHistoryReadPort({
      readRawEntries: async () => [
        u("u-1", null, "please read the file"),
        c("c-1", "u-1"),
        assistantText("a-1", "c-1", "I will read it."),
      ],
    });
    const restarted = new HistorianManager({
      store,
      readPort: port,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "opencode/deepseek-v4-flash",
    });
    await restarted.recover();
    assert.ok(
      restarted.getQueue().pendingCount() >= 1,
      "closing session re-enqueued for finalization",
    );
    await restarted.pumpOnce();
    const finalState = store.getSessionState(SESSION);
    assert.ok(
      finalState?.status === "closed" || finalState?.status === "closed_incomplete",
      `recover() must finalize closing sessions, got ${finalState?.status}`,
    );
    restarted.close();
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: duplicate wrapup never produces a second ContinuitySnapshot", async () => {
  const { manager, store, dir } = managerFixture([
    u("u-1", null, "hello"),
    c("c-1", "u-1"),
    assistantText("a-1", "c-1", "hi back"),
  ]);
  try {
    await manager.enqueueWrapup(SESSION);
    await manager.pumpOnce();
    assert.equal(
      store.listContinuitySnapshots(SESSION, 10).length,
      1,
      "first wrapup wrote one snapshot",
    );

    // Duplicate wrapup (e.g. recovery re-enqueue after crash): the terminal
    // transition is idempotent — no second snapshot, status stays closed.
    const again = await manager.enqueueWrapup(SESSION);
    assert.equal(again, true);
    await manager.pumpOnce();
    assert.equal(
      store.listContinuitySnapshots(SESSION, 10).length,
      1,
      "duplicate wrapup must not duplicate the snapshot",
    );
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: wrapup of a session whose head is an in-flight tool arc still terminates closing", async () => {
  // Assistant issued a toolCall (seq 1) whose toolResult never arrived → the
  // ENTIRE head is inside the protected tail (eligibleThroughEntrySeq=0,
  // verified: toolCall@1 + custom@2 freezes with eligibleThrough=0): nothing
  // is snapshot-able, but the durable closing must STILL terminate to closed
  // (BLOCKING-2: previously stranded closing forever, recover() spinning).
  const toolCallEntry: SessionTreeEntry = {
    type: "message",
    id: "a-tool-1",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", args: "{}" }],
      api: "x",
      provider: "m",
      model: "v",
      timestamp: 1,
    },
  } as unknown as SessionTreeEntry;
  const { manager, store, dir } = managerFixture([toolCallEntry, c("c-1", "a-tool-1", 2)]);
  try {
    await manager.enqueueWrapup(SESSION);
    // The freeze sees the in-flight arc: eligibleThroughEntrySeq stays 0, so
    // the wrapup has nothing to snapshot — but it must still finalize.
    await manager.pumpOnce();
    const state = store.getSessionState(SESSION);
    assert.ok(
      state?.status === "closed" || state?.status === "closed_incomplete",
      `in-flight-arc wrapup must terminate closing, got ${state?.status}`,
    );
    // And recovery after restart must not spin forever.
    const port = new SessionHistoryReadPort({
      readRawEntries: async () => [toolCallEntry, c("c-1", "a-tool-1", 2)],
    });
    const restarted = new HistorianManager({
      store,
      readPort: port,
      historyPort: stubHistoryPort(),
      modelProviderProfile: "opencode/deepseek-v4-flash",
    });
    await restarted.recover();
    await restarted.pumpOnce();
    const finalState = store.getSessionState(SESSION);
    assert.ok(
      finalState?.status === "closed" || finalState?.status === "closed_incomplete",
      `recovered in-flight-arc session must terminate, got ${finalState?.status}`,
    );
    restarted.close();
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
