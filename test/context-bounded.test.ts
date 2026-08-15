/**
 * R2-P3：有界 context.db（Phase C 中性化重写）。
 * - 软 cap：超限单元标记 disposition="exclude"（append-only，行不删除，
 *   provider 视图不可见，读取源头即过滤）；
 * - 硬 cap：insertUnit 抛 ContextBoundsExceededError + 记录紧急态（fail-closed）；
 * - 默认 cap 下正常 session 全 include（无回归）。
 */
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  ContextBoundsExceededError,
  ContextStore,
  HARD_UNITS_CAP,
  MAX_UNITS_PER_SESSION,
} from "../src/context/context-store.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import { cleanupDir, makeLineageInput, tempDir, userInput } from "./helpers/context-fixtures.js";

const LINEAGE = "identity-test";

function openStore(dir: string, options: { maxUnitsPerSession?: number } = {}): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), {
    lineageId: LINEAGE,
    ...options,
  });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

test("r2-p3: soft cap marks over-cap units excluded without deleting rows (append-only)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir, { maxUnitsPerSession: 3 });
    const ingest = new ContextIngest(store, LINEAGE);
    for (let i = 1; i <= 5; i += 1) {
      ingest.ingestRuntimeEvent(userInput({ eventId: `e${i}`, content: `msg ${i}` }));
    }
    // provider 视图（默认 include）：只有前 3 个。
    const visible = store.listUnits("session-1");
    assert.equal(visible.length, 3);
    // 全量视图：5 行都在（append-only，行永不物理删除）；超限单元
    // historianDisposition='exclude'（读取源头过滤）。
    const all = store.listUnits("session-1", { disposition: "all" });
    assert.equal(all.length, 5);
    assert.deepEqual(
      all.map((unit) => unit.historianDisposition),
      ["include", "include", "include", "exclude", "exclude"],
    );
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2-p3: hard cap throws typed error and records emergency state (fail-closed)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir, { maxUnitsPerSession: 3 });
    const ingest = new ContextIngest(store, LINEAGE);
    for (let i = 1; i <= 6; i += 1) {
      ingest.ingestRuntimeEvent(userInput({ eventId: `e${i}`, content: `msg ${i}` }));
    }
    // 第 7 个超过硬 cap（2 × 3 = 6）→ fail-closed。
    assert.throws(
      () => ingest.ingestRuntimeEvent(userInput({ eventId: "e7", content: "boom" })),
      ContextBoundsExceededError,
    );
    assert.equal(store.getLineage("session-1")?.emergencyState, "emergency_fail_closed");
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("r2-p3: default caps keep normal sessions fully included (no regression)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const ingest = new ContextIngest(store, LINEAGE);
    for (let i = 1; i <= 20; i += 1) {
      ingest.ingestRuntimeEvent(userInput({ eventId: `e${i}`, content: `msg ${i}` }));
    }
    const visible = store.listUnits("session-1");
    assert.equal(visible.length, 20);
    assert.equal(MAX_UNITS_PER_SESSION, 10_000);
    assert.equal(HARD_UNITS_CAP, 20_000);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});
