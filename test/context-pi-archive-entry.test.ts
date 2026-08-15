/**
 * Feature A2（iris_agent#130）：Pi archive provenance —— 专用判别
 * `PiArchiveEntryRef`（iris.pi_archive_entry_ref.v1）。
 *
 * 背景：旧 Pi 兼容路径用通用 ContextUnitSourceRefV1（sourceSchemaId =
 * iris.pi_archive_entry.v1，sourceId = entryId，sourceRevision = entrySeq），
 * 既没有持久化 archive owner（runtimeSessionId），又把 entrySeq 当作语义
 * revision。
 *
 * A2 修复：
 *  - sourceRef = PiArchiveEntryRef { runtimeSessionId, entryId, entrySeq?,
 *    sourceHash }；稳定 identity = runtimeSessionId + entryId；
 *  - entrySeq 是 archive-local locator：可保存、可恢复扫描、不是 semantic
 *    revision、不进入稳定 identity；
 *  - raw provenance 只依赖持久化 Unit/source information 即可定位原 Pi
 *    runtime/archive（不依赖当前 Session binding）；
 *  - Pi source 不使用 iris.dsh_message_ref.v1；不恢复 RuntimeEvent/
 *    ContextMessageUnit 双链。
 *
 * 覆盖（A2 AC）：
 *  - 两个 Pi Session 使用相同 entryId → 两个不同 source / Unit；
 *  - 同一 Pi entry 的 entrySeq locator 变化 → Unit identity 不变；
 *  - restart / rollover → raw lookup 仍能定位原 archive；
 *  - 仅给出持久化 ContextUnit → 能解析 runtimeSessionId + entryId；
 *  - Pi entry 构造 DshMessageRef → architecture gate fail。
 */
import { join } from "node:path";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import assert from "node:assert/strict";

import { Context, type Fiber } from "@deepseek-ai/cordis";

import {
  PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID,
  deriveContextUnitId,
  isDshMessageRef,
  isPiArchiveEntryRef,
  type ContextUnit,
  type PiArchiveEntryRef,
} from "../src/contracts/context-unit.js";
import { createIrisContextPlugin } from "../src/cordis/index.js";
import { cleanupDir, tempDir } from "./helpers/context-fixtures.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** 等待某服务在 ctx 上 ACTIVE（inject 驱动的异步加载，poll 直到可见）。 */
async function waitForActive(ctx: Context, name: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ctx.get(name, true) !== undefined) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`service ${name} did not become ACTIVE within timeout`);
}

async function mount(dir: string): Promise<{
  ctx: Context;
  fiber: Fiber;
  lineageId: string;
}> {
  const ctx = new Context();
  const fiber: Fiber = await ctx.plugin(
    createIrisContextPlugin({ dataRoot: dir, withHistorian: false }),
  );
  await waitForActive(ctx, "irisContext");
  const lineageId = ctx.irisContext.lineageId;
  // createLineage 幂等（restart 时 lineage 已存在）。
  if (ctx.irisContext.getStore().getLineageByLineageId(lineageId) === undefined) {
    ctx.irisContext.createLineage({
      lineageId,
      runtimeSessionId: "pi-session-1",
      providerProfileId: "pi-mock",
      canonicalSystemPrompt: "sys",
      systemProjectionHash: "hash",
      preparedAt: "2026-08-05T00:00:00.000Z",
    });
  }
  return { ctx, fiber, lineageId };
}

function admitEntry(
  service: { admitPiArchiveEntry(input: unknown): ContextUnit },
  input: {
    runtimeSessionId: string;
    entryId: string;
    entrySeq?: number;
    sourceHash: string;
    content: string;
  },
): ContextUnit {
  return service.admitPiArchiveEntry({
    runtimeSessionId: input.runtimeSessionId,
    entryId: input.entryId,
    ...(input.entrySeq !== undefined ? { entrySeq: input.entrySeq } : {}),
    sourceHash: input.sourceHash,
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { role: "user", content: input.content },
    runtimeSourceKind: "user",
  });
}

test("A2: PiArchiveEntryRef carries runtimeSessionId + entryId and persists archive owner", async () => {
  const dir = tempDir();
  try {
    const { ctx, fiber, lineageId } = await mount(dir);
    try {
      const unit = admitEntry(ctx.irisContext, {
        runtimeSessionId: "pi-session-1",
        entryId: "pi-entry-1",
        entrySeq: 7,
        sourceHash: "entry-hash-1",
        content: "pi hello",
      });
      assert.ok(isPiArchiveEntryRef(unit.sourceRef), "must be a dedicated PiArchiveEntryRef");
      const ref = unit.sourceRef as PiArchiveEntryRef;
      assert.equal(ref.schemaId, PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID);
      assert.equal(ref.runtimeSessionId, "pi-session-1");
      assert.equal(ref.entryId, "pi-entry-1");
      assert.equal(ref.entrySeq, 7);
      assert.equal(ref.sourceHash, "entry-hash-1");
      assert.ok(!isDshMessageRef(unit.sourceRef), "Pi source must NOT be a DshMessageRef");
      assert.equal(unit.unitId, deriveContextUnitId(lineageId, ref));
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("A2: two Pi Sessions with the same entryId → two distinct sources / Units", async () => {
  const dir = tempDir();
  try {
    const { ctx, fiber, lineageId } = await mount(dir);
    try {
      // session-1 是当前绑定：先接纳 unitA。
      const unitA = admitEntry(ctx.irisContext, {
        runtimeSessionId: "pi-session-1",
        entryId: "entry-dup",
        sourceHash: "hash-1",
        content: "session one",
      });
      // rollover 到第二个 Pi runtime Session（同一 lineage）。
      ctx.irisContext.getStore().bindCurrentSession(lineageId, "pi-session-2");
      const unitB = admitEntry(ctx.irisContext, {
        runtimeSessionId: "pi-session-2",
        entryId: "entry-dup",
        sourceHash: "hash-1",
        content: "session two",
      });
      assert.notEqual(
        unitA.unitId,
        unitB.unitId,
        "same entryId, different runtime → distinct unit",
      );
      const refA = unitA.sourceRef as PiArchiveEntryRef;
      const refB = unitB.sourceRef as PiArchiveEntryRef;
      assert.equal(refA.runtimeSessionId, "pi-session-1");
      assert.equal(refB.runtimeSessionId, "pi-session-2");
      // 两个 source 都持久化（同一 entryId 不合并）。
      assert.equal(
        ctx.irisContext.getStore().listContextUnits(lineageId, { disposition: "all" }).length,
        2,
      );
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("A2: entrySeq locator change → Unit identity unchanged", async () => {
  const dir = tempDir();
  try {
    const { ctx, fiber, lineageId } = await mount(dir);
    try {
      const unit = admitEntry(ctx.irisContext, {
        runtimeSessionId: "pi-session-1",
        entryId: "entry-1",
        entrySeq: 3,
        sourceHash: "hash-1",
        content: "hello",
      });
      // 同一 entry、entrySeq locator 变化（re-admission 带不同 entrySeq）→
      // identity 不变（幂等返回既有 Unit；entrySeq 不进入语义 revision）。
      const again = admitEntry(ctx.irisContext, {
        runtimeSessionId: "pi-session-1",
        entryId: "entry-1",
        entrySeq: 99,
        sourceHash: "hash-1",
        content: "hello",
      });
      assert.equal(again.unitId, unit.unitId, "entrySeq is a locator, not identity");
      assert.equal(
        ctx.irisContext.getStore().listContextUnits(lineageId, { disposition: "all" }).length,
        1,
        "locator change must not create a duplicate unit",
      );
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("A2: restart — raw provenance lookup resolves runtimeSessionId + entryId from the persisted unit", async () => {
  const dir = tempDir();
  try {
    const first = await mount(dir);
    let unitId = "";
    try {
      const unit = admitEntry(first.ctx.irisContext, {
        runtimeSessionId: "pi-session-1",
        entryId: "entry-1",
        entrySeq: 5,
        sourceHash: "hash-1",
        content: "hello",
      });
      unitId = unit.unitId;
    } finally {
      await first.fiber.dispose();
    }
    // restart：重开同一 dataRoot，raw lookup 只依赖持久化 unit 信息。
    const second = await mount(dir);
    try {
      const store = second.ctx.irisContext.getStore();
      const reloaded = store.getContextUnitByUnitId(second.lineageId, unitId);
      assert.ok(reloaded !== undefined, "unit survives restart");
      assert.ok(isPiArchiveEntryRef(reloaded.sourceRef));
      const ref = reloaded.sourceRef as PiArchiveEntryRef;
      // 仅给出持久化 ContextUnit → 能解析 runtimeSessionId + entryId
      // （不依赖当前 Session binding）。
      assert.equal(ref.runtimeSessionId, "pi-session-1");
      assert.equal(ref.entryId, "entry-1");
      assert.equal(ref.entrySeq, 5);
      assert.equal(ref.sourceHash, "hash-1");
      // 重新 ingest 同一 entry → 幂等（identity 稳定）。
      const again = admitEntry(second.ctx.irisContext, {
        runtimeSessionId: "pi-session-1",
        entryId: "entry-1",
        entrySeq: 5,
        sourceHash: "hash-1",
        content: "hello",
      });
      assert.equal(again.unitId, unitId);
      assert.equal(store.listContextUnits(second.lineageId, { disposition: "all" }).length, 1);
    } finally {
      await second.fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("A2: Pi entry constructed as a DshMessageRef fails the architecture gate", () => {
  // 生产代码：Pi 路径（iris_agent bridge）只能走 admitPiArchiveEntry；
  // context-service 的 Pi 专用入口不得构造 DshMessageRef。
  const service = fs.readFileSync(join(REPO_ROOT, "src", "cordis", "context-service.ts"), "utf8");
  assert.match(service, /admitPiArchiveEntry/);
  assert.match(service, /PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID/);
  const piBlock = service.slice(service.indexOf("admitPiArchiveEntry"));
  assert.ok(
    !piBlock.slice(0, 1200).includes("DSH_MESSAGE_REF_V1_SCHEMA_ID"),
    "admitPiArchiveEntry must not construct a DshMessageRef",
  );
  // 领域守卫：isDshMessageRef 对 PiArchiveEntryRef 返回 false。
  assert.equal(
    isDshMessageRef({
      schemaId: PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID,
      runtimeSessionId: "s",
      entryId: "e",
      sourceHash: "h",
    }),
    false,
    "PiArchiveEntryRef must never pass the DshMessageRef guard",
  );
});

test("A2: PiArchiveEntryRef never enters entrySeq into stable identity fields", () => {
  // locator-only：entrySeq 不在 sourceIdentityFields（unitId/anchor 共享）。
  // 通过派生验证：entrySeq 变化 → unitId 不变。
  const a = admitFromRef({ runtimeSessionId: "s1", entryId: "e1", entrySeq: 1, hash: "h" });
  const b = admitFromRef({ runtimeSessionId: "s1", entryId: "e1", entrySeq: 2, hash: "h" });
  assert.equal(a, b, "entrySeq must not enter the stable identity");
});

function admitFromRef(input: {
  runtimeSessionId: string;
  entryId: string;
  entrySeq: number;
  hash: string;
}): string {
  const { deriveContextUnitId: derive } = { deriveContextUnitId };
  return derive("lineage", {
    schemaId: PI_ARCHIVE_ENTRY_REF_V1_SCHEMA_ID,
    runtimeSessionId: input.runtimeSessionId,
    entryId: input.entryId,
    entrySeq: input.entrySeq,
    sourceHash: input.hash,
  });
}
