/**
 * Phase F：Cordis 插件化测试。
 *
 * 证明（Notion Composition & Plugin Model v29 + Long-Term Memory Boundary）：
 *  - 三个 typed services（irisContext / irisHistorian / irisMemory）经
 *    `declare module '@deepseek-ai/cordis'` 挂到 ctx，类型在 typecheck 生效；
 *  - 单向依赖：irisHistorian inject irisContext（PENDING 等待依赖齐备才
 *    ACTIVE）；
 *  - reversible effects：plugin unload 后 contributor / semantic adapter /
 *    auto-BUST event listener 全部注销（再触发不生效）；durable
 *    context.db / historian.db 行保留；
 *  - durable 双向：unload/reload 后 durable 行仍在，services 从 durable 重建；
 *  - provider 冲突 fail-closed：同一 adapter 二次 setAdapter 抛错；同一
 *    semanticSchemaId 二次注册抛错（不"最后注册者获胜"）；
 *  - P4 只经 BUST：irisMemory.recall 在 BUST 周期外调用 fail-closed
 *    （MemoryRecallNotAuthorizedError）；
 *  - scope：Identity scope 装配点标记 + Runtime Agent scope dispose 不影响
 *    Identity services。
 *
 * 无 Pi / Graphiti / Neo4j；无第二套 Plugin Manager（全部经 @deepseek-ai/cordis）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";

import {
  ContextService,
  HistorianService,
  MemoryAdapterConflictError,
  MemoryRecallNotAuthorizedError,
  MemoryService,
  createIrisContextPlugin,
  installIrisContext,
  installIrisIdentityScope,
  IRIS_IDENTITY_SCOPE,
  type IrisContextPluginConfig,
} from "../src/cordis/index.js";
import { unitsInLayerV3 } from "../src/context/generation-builder.js";
import { deriveContextUnitId } from "../src/contracts/context-unit.js";
import type { ContextGenerationV3 } from "../contracts/generated/types.js";
import {
  SemanticAdapterConflictError,
  type SemanticAdapter,
} from "../src/historian/semantic-adapter-registry.js";
import type { ContextSourceContributor } from "../src/context/bust-coordinator.js";
import type {
  MemoryServiceAdapter,
  RecallIntent,
} from "../src/memory/memory-integration-coordinator.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";

const SESSION = "session-1";

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

/** 挂载完整 iris 插件并等待 irisHistorian ACTIVE。 */
async function mountFull(ctx: Context, config: IrisContextPluginConfig): Promise<Fiber> {
  const fiber = await ctx.plugin(createIrisContextPlugin(config));
  await waitForActive(ctx, "irisHistorian");
  return fiber;
}

function makeIntent(contextGenerationId: string): RecallIntent {
  return {
    schemaId: "iris.recall_intent.v1",
    contextLineageId: "lineage-x",
    contextGenerationId,
    frozenAt: "2026-08-14T00:00:00.000Z",
    querySummary: "test recall",
    budget: { maxCandidates: 8 },
    sourceSnapshotHash: "snap-hash",
  };
}

/** 带调用计数的 fake Memory Service Adapter（明确标记为 mock）。 */
function fakeAdapter(sourceTrust: "observed" | "verified" | "generated" = "observed") {
  const adapter: MemoryServiceAdapter & { recallCalls: number } = {
    serviceId: "mem-test",
    epoch: "epoch-1",
    revision: "rev-1",
    recallCalls: 0,
    status: () => "ready" as const,
    recall: async (intent: RecallIntent) => {
      adapter.recallCalls += 1;
      return {
        status: "ready" as const,
        candidates: [
          {
            recollectionId: `rec-${intent.contextGenerationId}`,
            statement: "a recollection",
            sourceTrust,
          },
        ],
      };
    },
  };
  return adapter;
}

/** 带调用计数的 fake P0 contributor（明确标记为 mock）。 */
function trackingContributor(sourceId: string, text: string) {
  let calls = 0;
  const contributor: ContextSourceContributor = {
    layer: "p0",
    sourceId,
    sourceRevision: "1",
    sourceHash: `hash-${sourceId}`,
    project: () => {
      calls += 1;
      return [
        {
          contextUnitId: `static-${text}`,
          source: {
            schemaId: "iris.context_unit_source_ref.v1" as const,
            sourceSchemaId: "test.static.v1",
            sourceId,
            sourceHash: `hash-${sourceId}`,
          },
          semanticSchemaId: "iris.semantic.context_message.user.v1",
          semanticContent: { role: "user", content: text },
        },
      ];
    },
    invalidate: (id) => id === sourceId,
  };
  return { contributor, calls: () => calls };
}

// ---------------------------------------------------------------------------
// 1) 服务注册与类型化
// ---------------------------------------------------------------------------

test("cordis: irisContext.admitRuntimeMessage 是 DSH 正常 ingress（DshMessageRef → ContextUnit）", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    try {
      const lineageId = ctx.irisContext.lineageId;
      ctx.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
      const unit = ctx.irisContext.admitRuntimeMessage({
        sessionId: SESSION,
        messageId: "dsh-msg-1",
        eventSeq: 7,
        contentSchemaId: "iris.semantic.context_message.user.v1",
        content: { role: "user", content: "hello via DSH" },
      });
      assert.equal(unit.schemaId, "iris.context_unit.v3");
      const ref = unit.sourceRef as import("../src/contracts/context-unit.js").DshMessageRef;
      assert.equal(ref.schemaId, "iris.dsh_message_ref.v1");
      assert.equal(ref.sessionId, SESSION);
      assert.equal(ref.messageId, "dsh-msg-1");
      assert.equal(ref.eventSeq, 7);
      // 读回（统一 ContextUnit 路径）。
      const read = ctx.irisContext.getStore().getContextUnitByUnitId(lineageId, unit.unitId);
      assert.deepEqual(read?.content, { role: "user", content: "hello via DSH" });
      // 幂等。
      const again = ctx.irisContext.admitRuntimeMessage({
        sessionId: SESSION,
        messageId: "dsh-msg-1",
        contentSchemaId: "iris.semantic.context_message.user.v1",
        content: { role: "user", content: "hello via DSH" },
      });
      assert.equal(again.unitId, unit.unitId);
      // anti-echo：plugin 来源 → fail-closed。
      assert.throws(
        () =>
          ctx.irisContext.admitRuntimeMessage({
            sessionId: SESSION,
            messageId: "injected-1",
            contentSchemaId: "iris.semantic.context_message.user.v1",
            content: { role: "user", content: "AGENTS.md" },
            runtimeSourceKind: "plugin",
          }),
        /cannot be admitted as a real experience/,
      );
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("cordis: 三个 typed services 注册到 ctx（typecheck 证明 declare module 生效）", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    try {
      // 类型化访问（编译期证明）：ctx.irisContext / irisHistorian / irisMemory。
      assert.ok(ctx.irisContext instanceof ContextService);
      assert.ok(ctx.irisHistorian instanceof HistorianService);
      assert.ok(ctx.irisMemory instanceof MemoryService);
      // 运行时严格 get 也可见（ACTIVE fiber 的实现）。
      // 注：ctx.get() 与 ctx.xxx 各自返回独立 traceable proxy，不能 ===/deepEqual
      // 比较（inspect proxy 会触发 ctx 属性解析）；用 instanceof 断言实现类型。
      assert.ok(ctx.get("irisContext", true) instanceof ContextService);
      assert.ok(ctx.get("irisHistorian", true) instanceof HistorianService);
      assert.ok(ctx.get("irisMemory", true) instanceof MemoryService);
      // 单一 lineage（one per data root）贯通 Context/Historian。
      assert.equal(ctx.irisHistorian.health().ready, true);
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 2) inject 依赖（PENDING → ACTIVE）
// ---------------------------------------------------------------------------

test("cordis: irisHistorian inject 依赖 irisContext —— PENDING 直到依赖齐备才 ACTIVE", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    // 先加载 irisHistorian（无 irisContext）→ PENDING，service 不可见。
    const historianFiber = ctx.plugin(HistorianService, {
      databasePath: join(dir, "historian.db"),
    });
    assert.equal(historianFiber.state, 0, "PENDING while irisContext missing");
    assert.equal(ctx.get("irisHistorian", true), undefined, "PENDING service invisible");

    // 装配 irisMemory + irisContext（不装配 irisHistorian）。
    const baseFiber = await ctx.plugin(
      createIrisContextPlugin({ dataRoot: dir, withHistorian: false }),
    );
    try {
      assert.ok(ctx.irisContext, "irisContext ACTIVE");
      // irisContext ACTIVE → 依赖 notify → irisHistorian 自动加载。
      await historianFiber;
      assert.equal(historianFiber.state, 2, "ACTIVE once dependency is ready");
      assert.ok(ctx.irisHistorian instanceof HistorianService);
      assert.equal(ctx.irisHistorian.health().ready, true);
    } finally {
      await baseFiber.dispose();
      await historianFiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 3) reversible effects：unload 注销全部进程内注册；durable 保留
// ---------------------------------------------------------------------------

test("cordis: reversible effects —— auto-BUST listener 随 unload 注销；durable 行保留", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    const lineageId = ctx.irisContext.lineageId;
    ctx.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
    // Feature 5：DSH 正常 ingress 走统一 ContextUnit admission
    // （admitRuntimeMessage）—— Historian 只消费 v3 ContextUnit。
    ctx.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "u1",
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello" },
    });
    ctx.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "a1",
      contentSchemaId: "iris.semantic.context_message.assistant.v1",
      content: { role: "assistant", content: "world", timestamp: 1 },
    });

    // 装配点注册了 auto-BUST 监听（iris/historian-batch-committed）。
    const hooks = ctx.events._hooks;
    const listenerCount = () => (hooks["iris/historian-batch-committed"] ?? []).length;
    assert.ok(listenerCount() >= 1, "auto-BUST listener registered on assembly fiber");

    // trigger → pump → batch 原子提交 → auto-BUST 请求被提交。
    await ctx.irisHistorian.triggerIncremental(SESSION);
    await ctx.irisHistorian.pumpOnce();
    assert.ok(ctx.irisContext.pendingCount() >= 1, "auto-BUST requested on batch commit");
    assert.equal(
      ctx.irisHistorian.health().cursor.processedThroughContextSeq,
      2,
      "batch committed through seq 2",
    );

    // durable 文件与行存在。
    assert.ok(existsSync(join(dir, "context.db")));
    assert.ok(existsSync(join(dir, "historian.db")));
    assert.equal(
      ctx.irisContext.getStore().listContextUnits(lineageId, { disposition: "all" }).length,
      2,
    );

    // unload → 进程内 listener 全部注销。
    await fiber.dispose();
    assert.equal(listenerCount(), 0, "auto-BUST listener removed on unload");
    assert.equal(ctx.get("irisContext", true), undefined, "services unregistered");
    assert.equal(ctx.get("irisHistorian", true), undefined);

    // durable 状态保留（unload 不删 DB/Compartment/Publication/receipt/archive）。
    assert.ok(existsSync(join(dir, "context.db")));
    assert.ok(existsSync(join(dir, "historian.db")));
  } finally {
    cleanupDir(dir);
  }
});

test("cordis: reversible effects —— contributor unregister 后不再投影", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    const lineageId = ctx.irisContext.lineageId;
    ctx.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
    ctx.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "u1",
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "a" },
    });

    const { contributor, calls } = trackingContributor("persona", "p0-unit");
    const disposeContributor = ctx.irisContext.registerContributor(contributor);

    ctx.irisContext.requestBust("capability_catalog_changed", {
      schemaId: "iris.bust_evidence.v1",
    });
    const run1 = await ctx.irisContext.runBustIfPending();
    assert.equal(run1.published, true);
    assert.ok(calls() >= 1, "contributor projected during BUST");
    const gen1 = ctx.irisContext.getCurrentGeneration();
    assert.ok(gen1 !== null);
    const p0 = unitsInLayerV3(gen1, 0);
    // P0 contributor 只提供 source；Context admission 派生确定性 unitId。
    const expectedP0Id = deriveContextUnitId(lineageId, {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: "test.static.v1",
      sourceId: "persona",
      sourceHash: "hash-persona",
    });
    assert.ok(p0.some((unit) => unit.unitId === expectedP0Id));
    assert.equal((p0[0]?.sourceRef as { sourceId: string }).sourceId, "persona");

    // 可逆注销：disposer 后 contributor 不再投影。
    disposeContributor();
    const callsBefore = calls();
    ctx.irisContext.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
    const run2 = await ctx.irisContext.runBustIfPending();
    assert.equal(run2.published, true);
    assert.equal(calls(), callsBefore, "unregistered contributor not projected");
    const gen2 = ctx.irisContext.getCurrentGeneration();
    assert.ok(gen2 !== null);
    assert.equal(unitsInLayerV3(gen2, 0).length, 0, "P0 empty after contributor removal");
    await fiber.dispose();
  } finally {
    cleanupDir(dir);
  }
});

test("cordis: reversible effects —— semantic adapter unregister 释放 schemaId 所有权", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    const schemaId = "iris.semantic.test.v1";
    const adapterA: SemanticAdapter = { schemaIds: [schemaId], version: "1" };
    const disposeA = ctx.irisHistorian.registerSemanticAdapter(adapterA);
    assert.equal(ctx.irisHistorian.getAdapter(schemaId), adapterA);

    disposeA();
    assert.equal(ctx.irisHistorian.getAdapter(schemaId), undefined, "slot released");

    const adapterB: SemanticAdapter = { schemaIds: [schemaId], version: "2" };
    const disposeB = ctx.irisHistorian.registerSemanticAdapter(adapterB);
    assert.equal(ctx.irisHistorian.getAdapter(schemaId), adapterB);
    disposeB();
    await fiber.dispose();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 4) durable 双向：unload/reload 后 durable 行仍在，services 从 durable 重建
// ---------------------------------------------------------------------------

test("cordis: durable context/historian 行在 unload/reload 后仍在，services 从 durable 重建", async () => {
  const dir = tempDir();
  try {
    // 第一次挂载：ingest + historian commit。
    const ctx1 = new Context();
    const f1 = await mountFull(ctx1, { dataRoot: dir });
    const lineageId = ctx1.irisContext.lineageId;
    ctx1.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
    // Feature 5：DSH 正常 ingress 走统一 ContextUnit admission
    // （admitRuntimeMessage）—— Historian 只消费 v3 ContextUnit。
    ctx1.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "u1",
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "durable-a" },
    });
    ctx1.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "a1",
      contentSchemaId: "iris.semantic.context_message.assistant.v1",
      content: { role: "assistant", content: "durable-b", timestamp: 1 },
    });
    await ctx1.irisHistorian.triggerIncremental(SESSION);
    await ctx1.irisHistorian.pumpOnce();
    const before = ctx1.irisContext.getStore().listContextUnits(lineageId, { disposition: "all" });
    assert.equal(before.length, 2);
    assert.equal(ctx1.irisHistorian.health().cursor.processedThroughContextSeq, 2);
    assert.equal(ctx1.irisHistorian.health().publicationCount, 1);
    await f1.dispose();

    // 重新挂载（同一 dataRoot）→ 从 durable 重建。
    const ctx2 = new Context();
    const f2 = await mountFull(ctx2, { dataRoot: dir });
    try {
      const after = ctx2.irisContext.getStore().listContextUnits(lineageId, { disposition: "all" });
      assert.equal(after.length, 2, "durable context rows rebuilt after reload");
      assert.deepEqual(
        after.map((unit) => unit.unitId),
        before.map((unit) => unit.unitId),
      );
      assert.equal(after[0]?.contentSchemaId, "iris.semantic.context_message.user.v1");
      // Historian durable 状态重建：cursor 与 publication 计数保留。
      assert.equal(
        ctx2.irisHistorian.health().cursor.processedThroughContextSeq,
        2,
        "historian cursor preserved across reload",
      );
      assert.equal(
        ctx2.irisHistorian.health().publicationCount,
        1,
        "publication rows preserved across reload",
      );
    } finally {
      await f2.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 5) provider 冲突 fail-closed
// ---------------------------------------------------------------------------

test("cordis: provider 冲突 fail-closed —— 同一 adapter 二次 setAdapter 抛错；同一 schemaId 二次注册抛错", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    try {
      // Memory adapter：同一 adapter 二次 setAdapter → 抛错（不得覆盖）。
      const adapter = fakeAdapter();
      const dispose = ctx.irisMemory.setAdapter(adapter);
      assert.throws(() => ctx.irisMemory.setAdapter(adapter), MemoryAdapterConflictError);
      // 挂载期间异 adapter 也抛错（不"最后注册者获胜"）。
      assert.throws(() => ctx.irisMemory.setAdapter(fakeAdapter()), MemoryAdapterConflictError);
      dispose();
      // disposer 释放槽位 → 可再注册。
      const dispose2 = ctx.irisMemory.setAdapter(fakeAdapter());
      dispose2();

      // semantic adapter registry：同一 semanticSchemaId 二次注册 → 抛错。
      const schemaId = "iris.semantic.conflict.v1";
      const d1 = ctx.irisHistorian.registerSemanticAdapter({ schemaIds: [schemaId], version: "1" });
      assert.throws(
        () => ctx.irisHistorian.registerSemanticAdapter({ schemaIds: [schemaId], version: "2" }),
        SemanticAdapterConflictError,
      );
      d1();
      const d2 = ctx.irisHistorian.registerSemanticAdapter({ schemaIds: [schemaId], version: "2" });
      d2();
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 6) P4 只经 BUST
// ---------------------------------------------------------------------------

test("cordis: P4 recall 只经 BUST —— invocation-time recall fail-closed；BUST 周期内唯一调用", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    const lineageId = ctx.irisContext.lineageId;
    ctx.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
    ctx.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "u1",
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "a" },
    });

    const adapter = fakeAdapter();
    const disposeAdapter = ctx.irisMemory.setAdapter(adapter);
    assert.equal(ctx.irisMemory.status(), "ready");
    assert.equal(ctx.irisMemory.isConfigured(), true);

    // 非 BUST 周期调用 recall → fail-closed（P4 只有 canonical BUST 更新路径）。
    const intent = makeIntent("gen-invocation");
    await assert.rejects(
      () => ctx.irisMemory.recall(intent),
      MemoryRecallNotAuthorizedError,
      "invocation-time recall rejected",
    );
    assert.equal(adapter.recallCalls, 0, "adapter recall never reached outside BUST");

    // BUST 周期：requestBust → runBustIfPending → P4 recall 恰好一次。
    ctx.irisContext.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
    const run = await ctx.irisContext.runBustIfPending();
    assert.equal(run.published, true);
    assert.equal(adapter.recallCalls, 1, "adapter recall invoked exactly once through BUST");
    const generation = ctx.irisContext.getCurrentGeneration();
    assert.ok(generation !== null);

    // 其他 service 方法绝不触发 invocation-time recall。
    const before = adapter.recallCalls;
    await ctx.irisHistorian.triggerIncremental(SESSION);
    ctx.irisMemory.status();
    ctx.irisHistorian.health();
    ctx.irisContext.pendingCount();
    assert.equal(adapter.recallCalls, before, "non-BUST service methods never recall");

    disposeAdapter();
    await fiber.dispose();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 7) typed events（经 ctx.emit；listener 随 fiber 清理）
// ---------------------------------------------------------------------------

test("cordis: typed events 经 ctx.emit 发出（bust-requested / generation-published）", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await mountFull(ctx, { dataRoot: dir });
    const lineageId = ctx.irisContext.lineageId;
    ctx.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
    ctx.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "u1",
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "a" },
    });

    const bustReasons: string[] = [];
    const offBust = ctx.on("iris/bust-requested", (reason) => {
      bustReasons.push(reason);
    });
    const publishedBox = { generation: null as ContextGenerationV3 | null };
    const offPublished = ctx.on("iris/context-generation-published", (generation) => {
      publishedBox.generation = generation;
    });

    ctx.irisContext.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
    assert.deepEqual(bustReasons, ["operator_requested"]);
    const run = await ctx.irisContext.runBustIfPending();
    assert.equal(run.published, true);
    assert.ok(publishedBox.generation !== null, "generation-published event fired");
    assert.ok(publishedBox.generation.header.contextGenerationHash.length > 0);

    offBust();
    offPublished();
    await fiber.dispose();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 8) scope：Identity scope 与 Runtime Agent scope 分离
// ---------------------------------------------------------------------------

test("cordis: scope —— Agent scope dispose 不 dispose Identity services", async () => {
  const dir = tempDir();
  try {
    const root = new Context();
    // Identity scope 装配点：明确标记；iris services 挂在此 ctx 上。
    const identity = installIrisIdentityScope(root);
    assert.ok(identity[IRIS_IDENTITY_SCOPE], "identity scope marker set");

    const fiber = await mountFull(identity, { dataRoot: dir });
    const lineageId = identity.irisContext.lineageId;
    identity.irisContext.createLineage(makeLineageInput(SESSION, lineageId));
    identity.irisContext.admitRuntimeMessage({
      sessionId: SESSION,
      messageId: "u1",
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "a" },
    });

    // Runtime Agent scope：Identity 之下的独立 fiber（agent facet）。
    const agentObserved = { generationId: undefined as string | undefined };
    const agentFacet = ((agentCtx: Context) => {
      agentCtx.on("iris/context-generation-published", (generation) => {
        agentObserved.generationId = generation.header.contextGenerationId;
      });
      return () => {
        /* agent 进程内 teardown */
      };
    }) as Plugin.Function;
    Object.defineProperty(agentFacet, "name", { value: "agent-facet" });
    const agentFiber = await identity.plugin(agentFacet);

    // Agent scope 正常工作：BUST 发布 → agent listener 收到事件。
    identity.irisContext.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
    const run = await identity.irisContext.runBustIfPending();
    assert.equal(run.published, true);
    assert.ok(
      agentObserved.generationId !== undefined,
      "agent-scoped listener observed publication",
    );

    // dispose 单个 Agent scope。
    await agentFiber.dispose();

    // Identity services 不受影响（Agent dispose 不 dispose Identity scope）。
    assert.ok(identity.irisContext, "irisContext still ACTIVE");
    assert.ok(identity.irisHistorian, "irisHistorian still ACTIVE");
    assert.ok(identity.irisMemory, "irisMemory still ACTIVE");
    assert.ok(identity.irisContext.getCurrentGeneration() !== null, "generation retained");

    // Agent 的 listener 已随其 fiber 清理：再发布不再被 agent 观察到。
    agentObserved.generationId = undefined;
    identity.irisContext.requestBust("operator_requested", { schemaId: "iris.bust_evidence.v1" });
    await identity.irisContext.runBustIfPending();
    assert.equal(
      agentObserved.generationId,
      undefined,
      "agent-scoped listener disposed with agent scope",
    );

    await fiber.dispose();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 9) installIrisContext（imperative 装配等价物）
// ---------------------------------------------------------------------------

test("cordis: installIrisContext 装配等价于 ctx.plugin(createIrisContextPlugin)", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber = await installIrisContext(ctx, { dataRoot: dir });
    await waitForActive(ctx, "irisHistorian");
    try {
      assert.ok(ctx.irisContext);
      assert.ok(ctx.irisHistorian);
      assert.ok(ctx.irisMemory);
      assert.ok(ctx.irisContext.isOpen());
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});
