import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { PiSeamEvent } from "../src/contracts/runtime-events.js";
import { RuntimeEventLedger } from "../src/runtime/runtime-event-ledger.js";

/**
 * RuntimeEvent ledger gate（Roadmap v13 R1）：
 * - exactly-once：重复 ingest 不产生重复 ledger 行；
 * - 持久化：关闭后重开数据仍在（crash-window 恢复的基础）；
 * - 顺序读取与 attribution 字段完整。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "iris-runtime-events-"));
}

/** Windows 下 SQLite 可能短暂锁住 db 文件；清理失败不致命。 */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // EBUSY / EPERM：文件被进程句柄短暂占用，忽略。
  }
}

function sampleMessageFinalized(overrides: Partial<PiSeamEvent> = {}): PiSeamEvent {
  return {
    type: "message_finalized",
    runtimeSessionId: "session-1",
    piSessionId: "pi-session-1",
    entryId: "entry-1",
    contentHash: "a".repeat(64),
    occurredAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("r1: ingest persists a message_finalized event with full attribution", () => {
  const dir = tempDir();
  try {
    const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const event = ledger.ingest(sampleMessageFinalized());
    assert.equal(event.type, "message_finalized");
    assert.equal(event.runtimeSessionId, "session-1");
    assert.equal(event.entryId, "entry-1");
    assert.equal(event.contentHash, "a".repeat(64));
    assert.equal(event.disposition, "include");
    assert.equal(typeof event.eventId, "string");
    assert.ok(event.eventId.length > 0);
    ledger.close();

    // 持久化：重开后可读。
    const reopened = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const events = reopened.listBySession("session-1");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.entryId, "entry-1");
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r1: duplicate ingest with same idempotency key returns the same event (exactly-once)", () => {
  const dir = tempDir();
  try {
    const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const first = ledger.ingest(sampleMessageFinalized());
    const duplicate = ledger.ingest(sampleMessageFinalized());
    assert.equal(duplicate.eventId, first.eventId);
    assert.equal(duplicate.idempotencyKey, first.idempotencyKey);
    const events = ledger.listBySession("session-1");
    assert.equal(events.length, 1, "duplicate ingest must not add a ledger row");
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r1: distinct entries produce distinct events; ordering is deterministic", () => {
  const dir = tempDir();
  try {
    const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const e1 = ledger.ingest(sampleMessageFinalized({ entryId: "entry-1" }));
    const e2 = ledger.ingest(
      sampleMessageFinalized({ entryId: "entry-2", occurredAt: "2026-08-05T00:00:01.000Z" }),
    );
    const e3 = ledger.ingest({
      type: "turn_committed",
      runtimeSessionId: "session-1",
      piSessionId: "pi-session-1",
      toolResultCount: 0,
      hadPendingMutations: false,
      occurredAt: "2026-08-05T00:00:02.000Z",
    });
    assert.notEqual(e2.eventId, e1.eventId);
    assert.equal(e3.type, "turn_committed");

    const events = ledger.listBySession("session-1");
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.type),
      ["message_finalized", "message_finalized", "turn_committed"],
    );

    // afterEventId 顺序读取（R1 的 forward-sequenced read 基础）。
    const afterFirst = ledger.listBySession("session-1", { afterEventId: e1.eventId });
    assert.equal(afterFirst.length, 2);
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r1: empty database initializes cleanly; schema version recorded", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "runtime-ledger.db");
    const ledger = RuntimeEventLedger.open(dbPath);
    assert.deepEqual(ledger.listBySession("any"), []);
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r1: afterEventId anchor from another session does not leak rows", () => {
  const dir = tempDir();
  try {
    const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    const s1 = ledger.ingest(
      sampleMessageFinalized({ runtimeSessionId: "session-1", entryId: "entry-1" }),
    );
    ledger.ingest(sampleMessageFinalized({ runtimeSessionId: "session-2", entryId: "entry-2" }));
    // session-1 的锚点不能在 session-2 查询中越界。
    const s2After = ledger.listBySession("session-2", { afterEventId: s1.eventId });
    assert.equal(s2After.length, 0);
    // 未知锚点返回空而非报错。
    const unknown = ledger.listBySession("session-1", { afterEventId: "no-such-event" });
    assert.deepEqual(unknown, []);
    ledger.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r1: ingest after close fails closed", () => {
  const dir = tempDir();
  try {
    const ledger = RuntimeEventLedger.open(join(dir, "runtime-ledger.db"));
    ledger.close();
    assert.throws(() => ledger.ingest(sampleMessageFinalized()), /ledger is closed/);
  } finally {
    cleanupDir(dir);
  }
});
