/**
 * Phase E：Retention（ContextRetirementPortV1 markRepresentedAndRetired /
 * reclaimRetiredPayloads）测试。
 *
 * 证明：
 *  - markRepresentedAndRetired 只允许在 canonical BUST 原子发布事务内调用
 *    （事务外 fail-closed）；事务内推进 represented/retired watermark、绑定
 *    新 generation id+hash、覆盖 units 的 lifecycle 推进（represented_in_p3 /
 *    retired）；watermark 单调只进不退；retired ≤ represented。
 *  - reclaimRetiredPayloads 只回收 retired 单元的 semantic payload（冷迁移
 *    占位），保留 identity/hash/binding/disposition/archive locator；返回
 *    回收行数/字节；有界（maxRows/maxBytes）；幂等。
 *  - 已回收行的读路径不重算 hash（fail-closed 断言 lifecycle=retired），
 *    返回冷迁移 marker，不进入 P5（lifecycle 过滤）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { ContextStore } from "../src/context/context-store.js";
import { ContextIngest } from "../src/context/context-ingest.js";
import { createContextRetirementPort } from "../src/context/context-retirement-port.js";
import type { ContextRetirementPortV1 } from "../src/contracts/context-retirement.js";
import {
  newClaimId,
  newReceiptId,
  type HistorianCommitReceiptV1,
} from "../src/contracts/historian.js";
import { userOrigin } from "./helpers/context-fixtures.js";
import {
  assistantInput,
  cleanupDir,
  makeLineageInput,
  tempDir,
  userInput,
} from "./helpers/context-fixtures.js";

const LINEAGE = "lineage-retention-test";

function openStore(dir: string): {
  store: ContextStore;
  ingest: ContextIngest;
  port: ContextRetirementPortV1;
} {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  const ingest = new ContextIngest(store, LINEAGE);
  const port = createContextRetirementPort(store);
  return { store, ingest, port };
}

function receipt(from: number, through: number): HistorianCommitReceiptV1 {
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
    compartmentIds: [`compartment-${LINEAGE}-1`],
    publicationIds: [],
    outputHash: "oh",
    committedAt: "2026-08-01T00:00:00.000Z",
  };
}

async function ingestThree(dir: string) {
  const env = openStore(dir);
  env.ingest.ingestRuntimeEvent(userInput({ eventId: "e1", content: "a", sessionId: "session-1" }));
  env.ingest.ingestRuntimeEvent(
    assistantInput({ eventId: "e2", content: "b", sessionId: "session-1" }),
  );
  env.ingest.ingestRuntimeEvent(userInput({ eventId: "e3", content: "c", sessionId: "session-1" }));
  // 全部 ACK → compartmentalized_pending_bust
  env.port.acknowledgeHistorianCommit(receipt(1, 3));
  return env;
}

/**
 * 在 canonical BUST 原子发布事务内调用 markRepresentedAndRetired（与
 * BustCoordinator 的调用方式一致：事务由调用方在 ContextStore 上开启）。
 */
function retire(
  env: { store: ContextStore; port: ContextRetirementPortV1 },
  input: Parameters<ContextRetirementPortV1["markRepresentedAndRetired"]>[0],
): void {
  env.store.beginBustTransaction();
  try {
    env.port.markRepresentedAndRetired(input);
    env.store.commitBustTransaction();
  } catch (error) {
    env.store.rollbackBustTransaction();
    throw error;
  }
}

test("retention: markRepresentedAndRetired inside BUST transaction advances watermarks + lifecycle + binds generation", async () => {
  const dir = tempDir();
  try {
    const env = await ingestThree(dir);
    try {
      retire(env, {
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-1",
        contextGenerationHash: "hash-gen-1",
        representedThroughContextSeq: 3,
        retiredThroughContextSeq: 3,
      });
      const lineage = env.store.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 3);
      assert.equal(lineage?.retiredThroughContextSeq, 3);
      assert.equal(lineage?.lastBustGenerationId, "gen-1");
      assert.equal(lineage?.lastBustGenerationHash, "hash-gen-1");
      assert.ok(lineage?.lastBustAt, "bust time recorded");
      for (const unit of env.store.listUnitsByLineageRange(LINEAGE, 1, 3)) {
        assert.equal(unit.lifecycleState, "retired", "covered units retired");
      }
    } finally {
      env.store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("retention: represented > retired keeps an intermediate represented_in_p3 band", async () => {
  const dir = tempDir();
  try {
    const env = await ingestThree(dir);
    try {
      retire(env, {
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-2",
        contextGenerationHash: "hash-gen-2",
        representedThroughContextSeq: 3,
        retiredThroughContextSeq: 1,
      });
      const units = env.store.listUnitsByLineageRange(LINEAGE, 1, 3);
      assert.equal(units[0]?.lifecycleState, "retired", "seq 1 retired (≤ retiredThrough)");
      assert.equal(units[1]?.lifecycleState, "represented_in_p3", "seq 2 represented only");
      assert.equal(units[2]?.lifecycleState, "represented_in_p3", "seq 3 represented only");
    } finally {
      env.store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("retention: watermarks are monotonic — a smaller advance never regresses", async () => {
  const dir = tempDir();
  try {
    const env = await ingestThree(dir);
    try {
      retire(env, {
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-3",
        contextGenerationHash: "h3",
        representedThroughContextSeq: 3,
        retiredThroughContextSeq: 3,
      });
      retire(env, {
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-4",
        contextGenerationHash: "h4",
        representedThroughContextSeq: 1, // smaller — must not regress
        retiredThroughContextSeq: 0,
      });
      const lineage = env.store.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 3, "no regression");
      assert.equal(lineage?.retiredThroughContextSeq, 3, "no regression");
      // generation 绑定更新为最近一次成功 BUST
      assert.equal(lineage?.lastBustGenerationId, "gen-4");
    } finally {
      env.store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("retention: retired > represented is rejected (fail closed)", async () => {
  const dir = tempDir();
  try {
    const env = await ingestThree(dir);
    try {
      assert.throws(() => {
        retire(env, {
          contextLineageId: LINEAGE,
          contextGenerationId: "gen-bad",
          contextGenerationHash: "h-bad",
          representedThroughContextSeq: 1,
          retiredThroughContextSeq: 3,
        });
      }, /retiredThroughContextSeq/);
      const lineage = env.store.getLineageByLineageId(LINEAGE);
      assert.equal(lineage?.representedThroughContextSeq, 0, "rollback: no watermark advance");
      assert.equal(lineage?.retiredThroughContextSeq, 0);
    } finally {
      env.store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("retention: reclaimRetiredPayloads reclaims only retired payloads, preserves identity/hash/disposition/archive", async () => {
  const dir = tempDir();
  try {
    const env = openStore(dir);
    try {
      // 带 rawArchiveRef 的 user 单元（archive locator 保留）。
      env.ingest.ingestRuntimeEvent({
        eventId: "e1",
        kind: "user",
        runtimeSessionId: "session-1",
        role: "user",
        payload: { role: "user", content: "archived input" },
        origin: userOrigin(),
        rawArchiveRef: {
          schemaId: "iris.raw_archive_ref.v1",
          runtimeSessionId: "session-1",
          entryIds: ["entry-1"],
        },
        occurredAt: "2026-08-01T00:00:00.000Z",
        idempotencyKey: "user:e1",
      });
      env.ingest.ingestRuntimeEvent(
        assistantInput({ eventId: "e2", content: "b", sessionId: "session-1" }),
      );
      env.port.acknowledgeHistorianCommit(receipt(1, 2));
      retire(env, {
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-5",
        contextGenerationHash: "h5",
        representedThroughContextSeq: 2,
        retiredThroughContextSeq: 2,
      });

      // 记录回收前的行状态（identity/hash/disposition/archive）
      const before = env.store
        .raw()
        .prepare(
          "SELECT unit_id, content_hash, disposition, raw_archive_ref, LENGTH(payload) AS bytes FROM context_units WHERE context_lineage_id = ? ORDER BY context_seq",
        )
        .all(LINEAGE) as unknown as Array<{
        unit_id: string;
        content_hash: string;
        disposition: string;
        raw_archive_ref: string | null;
        bytes: number;
      }>;
      const expectedBytes = before.reduce((sum, row) => sum + (row.bytes ?? 0), 0);

      const gc = env.port.reclaimRetiredPayloads({ maxRows: 100, maxBytes: 1_000_000 });
      assert.equal(gc.reclaimedRows, 2, "both retired rows reclaimed");
      assert.equal(gc.reclaimedBytes, expectedBytes, "bytes = sum of original payload lengths");
      assert.equal(gc.remainingRetiredRows, 0);

      // identity/hash/disposition/archive locator 保留；payload 被冷迁移占位替换
      const after = env.store
        .raw()
        .prepare(
          "SELECT unit_id, content_hash, disposition, raw_archive_ref, payload_reclaimed_at, payload FROM context_units WHERE context_lineage_id = ? ORDER BY context_seq",
        )
        .all(LINEAGE) as unknown as Array<{
        unit_id: string;
        content_hash: string;
        disposition: string;
        raw_archive_ref: string | null;
        payload_reclaimed_at: string | null;
        payload: string;
      }>;
      for (let i = 0; i < before.length; i += 1) {
        assert.equal(after[i]?.unit_id, before[i]?.unit_id, "identity preserved");
        assert.equal(after[i]?.content_hash, before[i]?.content_hash, "content hash preserved");
        assert.equal(after[i]?.disposition, before[i]?.disposition, "disposition preserved");
        assert.equal(
          after[i]?.raw_archive_ref,
          before[i]?.raw_archive_ref,
          "archive locator preserved",
        );
        assert.ok(after[i]?.payload_reclaimed_at, "payload reclaimed marker set");
        assert.ok(
          !after[i]?.payload.includes("archived input") && !after[i]?.payload.includes("assistant"),
          "original semantic payload cleared (cold migration)",
        );
        assert.match(after[i]?.payload ?? "", /cold_migration_marker/);
      }

      // 已回收行读路径：不抛错、返回冷迁移 marker、不进入 P5。
      const units = env.store.listUnitsByLineageRange(LINEAGE, 1, 2);
      assert.equal(units.length, 2);
      for (const unit of units) {
        assert.equal(unit.lifecycleState, "retired");
        assert.equal(
          (unit.semanticContent as Record<string, unknown>)["schemaId"],
          "iris.cold_migration_marker.v1",
        );
      }
      assert.equal(
        env.store.listLiveUnitsForP5(LINEAGE, 0).length,
        0,
        "reclaimed retired units never enter P5",
      );

      // 幂等：再次回收 0 行。
      const again = env.port.reclaimRetiredPayloads({ maxRows: 100, maxBytes: 1_000_000 });
      assert.equal(again.reclaimedRows, 0);
    } finally {
      env.store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("retention: reclaim is bounded by maxRows / maxBytes and never touches non-retired units", async () => {
  const dir = tempDir();
  try {
    const env = await ingestThree(dir);
    try {
      // 只退休前 2 个单元；第 3 个保持 pending_bust（未退休）。
      retire(env, {
        contextLineageId: LINEAGE,
        contextGenerationId: "gen-6",
        contextGenerationHash: "h6",
        representedThroughContextSeq: 2,
        retiredThroughContextSeq: 2,
      });
      // maxRows=1 → 只回收 1 行
      const one = env.port.reclaimRetiredPayloads({ maxRows: 1, maxBytes: 1_000_000 });
      assert.equal(one.reclaimedRows, 1);
      assert.equal(one.remainingRetiredRows, 1);
      // maxBytes=1 → 连 1 行都收不动（首个候选超预算时停止）
      const zero = env.port.reclaimRetiredPayloads({ maxRows: 100, maxBytes: 1 });
      assert.equal(zero.reclaimedRows, 0);
      // 未退休的 pending_bust 单元不被回收
      const pending = env.store.listUnitsByLineageRange(LINEAGE, 3, 3)[0];
      assert.equal(pending?.lifecycleState, "compartmentalized_pending_bust");
      assert.equal(
        (pending?.semanticContent as Record<string, unknown>)["content"],
        "c",
        "unretired payload intact",
      );
      // 非 retired 行没有 payload_reclaimed_at
      const row = env.store
        .raw()
        .prepare(
          "SELECT payload_reclaimed_at AS p FROM context_units WHERE context_lineage_id = ? AND context_seq = 3",
        )
        .get(LINEAGE) as { p: string | null };
      assert.equal(row.p, null);
    } finally {
      env.store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
