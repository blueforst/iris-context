/**
 * Feature 4（iris-context#2）：DSH MessageRef ingress + anti-echo。
 *
 * 覆盖：
 *  - DSH user/message ingress（admitRuntimeMessage → ContextUnit）；
 *  - DSH assistant/message、tool/result ingress（各自语义 schema）；
 *  - DSH Session rollover：bindCurrentSession 到新 session 后 contextSeq 单调、
 *    lineage 不重置；
 *  - restart/recovery：重开 store 后 re-admit exactly-once（同一 Unit）；
 *  - message source anti-echo：user-role 内容声明为 plugin/injected 来源 →
 *    fail-closed 拒绝（合成上下文不是真人 experience）；
 *  - P0–P4 不写入 DSH Session：结构门 —— Context 生产代码不持有任何 DSH
 *    Session 写能力（无 DSH 依赖；持久化只进 context.db）。
 */
import { join } from "node:path";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import assert from "node:assert/strict";

import { Context, type Fiber } from "@deepseek-ai/cordis";

import { ContextAdmission } from "../src/context/context-admission.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  DSH_MESSAGE_REF_V1_SCHEMA_ID,
  isGenericSourceRef,
  type ContextUnit,
  type DshMessageRef,
} from "../src/contracts/context-unit.js";
import { createIrisContextPlugin } from "../src/cordis/index.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";

const LINEAGE = "lineage-dsh-ingress";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function openStore(dir: string): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

function admitUser(
  admission: ContextAdmission,
  sessionId: string,
  messageId: string,
  content: string,
  runtimeSourceKind?: "user" | "plugin" | "model" | "tool" | "other",
): ContextUnit {
  return admission.admit({
    sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId, messageId },
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { role: "user", content },
    runtimeSessionId: sessionId,
    ...(runtimeSourceKind !== undefined ? { runtimeSourceKind } : {}),
  });
}

test("F4: DSH user/message ingress → ContextUnit with DshMessageRef source", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    const unit = admitUser(admission, "session-1", "m1", "hello dsh");
    assert.equal(unit.schemaId, "iris.context_unit.v3");
    assert.ok(unit.sourceRef.schemaId === DSH_MESSAGE_REF_V1_SCHEMA_ID);
    const ref = unit.sourceRef as DshMessageRef;
    assert.equal(ref.sessionId, "session-1");
    assert.equal(ref.messageId, "m1");
    assert.deepEqual(unit.content, { role: "user", content: "hello dsh" });
    assert.equal(unit.contentHash.length, 64);
    // 持久化：读回同一 Unit。
    const read = store.getContextUnitByUnitId(LINEAGE, unit.unitId);
    assert.deepEqual(read?.content, unit.content);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F4: DSH assistant/message and tool/result ingress → ContextUnit", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    const assistant = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s", messageId: "a1" },
      contentSchemaId: "iris.semantic.context_message.assistant.v1",
      content: { role: "assistant", content: "assistant reply", timestamp: 1 },
      runtimeSessionId: "session-1",
    });
    assert.equal(assistant.sourceRef.schemaId, DSH_MESSAGE_REF_V1_SCHEMA_ID);
    assert.deepEqual(assistant.content, {
      role: "assistant",
      content: "assistant reply",
      timestamp: 1,
    });

    const toolResult = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s", messageId: "t1" },
      contentSchemaId: "iris.semantic.context_message.tool_result.v1",
      content: {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 1,
      },
      runtimeSessionId: "session-1",
    });
    assert.deepEqual(toolResult.content, {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 1,
    });
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F4: DSH Session rollover — lineage continues, contextSeq monotonic, no reset", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    const u1 = admitUser(admission, "session-1", "m1", "first");
    // rollover：绑定新 session（同一 lineage）。
    store.bindCurrentSession(LINEAGE, "session-2");
    const u2 = admitUser(admission, "session-2", "m2", "second");
    // 同一 lineage；contextSeq 单调（u2 在 u1 之后）；identity 稳定。
    assert.equal(u1.contextId, LINEAGE);
    assert.equal(u2.contextId, LINEAGE);
    const units = store.listContextUnits(LINEAGE, { disposition: "all" });
    assert.equal(units.length, 2);
    assert.notEqual(u1.unitId, u2.unitId, "different messages → different units");
    // 新 session 的消息按旧 session 之后继续排序（context_seq 由 store 分配）。
    assert.equal(store.maxContextSeqByLineage(LINEAGE), 2);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F4: restart/recovery — re-admit after reopen is exactly-once (same Unit)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    const u1 = admitUser(admission, "session-1", "m1", "persist me");
    store.close();

    // 重开：迁移/持久化后 re-admit 同一 source → 同一 Unit（不重复行）。
    // lineage 已持久化，重开无需再 createLineage。
    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const admission2 = new ContextAdmission(reopened);
    const u2 = admitUser(admission2, "session-1", "m1", "persist me");
    assert.equal(u2.unitId, u1.unitId);
    assert.deepEqual(u2.content, u1.content);
    assert.equal(
      reopened.listContextUnits(LINEAGE, { disposition: "all" }).length,
      1,
      "exactly-once",
    );
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F4: message source anti-echo — plugin/injected user content is rejected (fail closed)", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    // DSH user/message 的 source.kind='plugin'（synthetic context / recall /
    // notice / instructions）→ 不得成为真实 experience。
    assert.throws(
      () => admitUser(admission, "session-1", "injected-1", "AGENTS.md instructions", "plugin"),
      /cannot be admitted as a real experience/,
    );
    assert.throws(
      () => admitUser(admission, "session-1", "injected-2", "recall echo", "other"),
      /cannot be admitted as a real experience/,
    );
    // 声明为真实 user → 正常接纳。
    const real = admitUser(admission, "session-1", "real-1", "human question", "user");
    assert.ok(real !== undefined);
    // 未声明（缺省）→ 允许（adapter 负责过滤；兼容既有调用方）。
    const unlabeled = admitUser(admission, "session-1", "real-2", "human again");
    assert.ok(unlabeled !== undefined);
    // 没有任何 plugin 注入内容被持久化。
    assert.equal(store.listContextUnits(LINEAGE, { disposition: "all" }).length, 2);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F4: P0-P4 never written to DSH Session — Context has no DSH session write capability", () => {
  // 结构门：Context 生产代码不依赖 DSH（无 @deepseek-ai/dsh* import），
  // 持久化只进 context.db；不存在任何"写入 DSH Session"的 API。
  const srcDir = join(REPO_ROOT, "src");
  function walk(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((e) => {
      const full = join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  }
  const tsFiles = walk(srcDir).filter((f) => f.endsWith(".ts"));
  for (const f of tsFiles) {
    const content = fs.readFileSync(f, "utf8");
    assert.ok(
      !content.includes("@deepseek-ai/dsh"),
      `${f} must not depend on DSH packages (Context owns no DSH session)`,
    );
    assert.ok(
      !/\bsession\.append\s*\(/.test(content) &&
        !/\bSessionStore\b/.test(content) &&
        !/\bSurfaceOp\b/.test(content),
      `${f} must not write DSH session surface state (P0-P4 are never written to DSH Session)`,
    );
  }
  // 持久化权威只经 ContextStore（context.db）；admission/store 是唯一写路径。
  assert.ok(fs.existsSync(join(REPO_ROOT, "src/context/context-store.ts")));
});

// ---------------------------------------------------------------------------
// iris_agent#130：Pi compatibility 通用 source admission（非 DshMessageRef）
// ---------------------------------------------------------------------------

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

test("F4: admitGenericRuntimeSource 使用通用 source ref（不伪装 DshMessageRef）", async () => {
  const dir = tempDir();
  try {
    const ctx = new Context();
    const fiber: Fiber = await ctx.plugin(
      createIrisContextPlugin({ dataRoot: dir, withHistorian: false }),
    );
    try {
      await waitForActive(ctx, "irisContext");
      const lineageId = ctx.irisContext.lineageId;
      ctx.irisContext.createLineage({
        lineageId,
        runtimeSessionId: "pi-session-1",
        providerProfileId: "pi-mock",
        canonicalSystemPrompt: "sys",
        systemProjectionHash: "hash",
        preparedAt: "2026-08-05T00:00:00.000Z",
      });
      const unit = ctx.irisContext.admitGenericRuntimeSource({
        sourceSchemaId: "iris.pi_archive_entry.v1",
        sourceId: "pi-entry-1",
        sourceRevision: "7",
        sourceHash: "entry-hash-1",
        contentSchemaId: "iris.semantic.context_message.user.v1",
        content: { role: "user", content: "pi hello" },
        runtimeSessionId: "pi-session-1",
        runtimeSourceKind: "user",
      });
      // 通用 source ref —— 不是 DshMessageRef（raw provenance 无歧义）。
      assert.ok(isGenericSourceRef(unit.sourceRef));
      const ref = unit.sourceRef as {
        schemaId: string;
        sourceSchemaId: string;
        sourceId: string;
        sourceRevision?: string;
        sourceHash: string;
      };
      assert.equal(ref.schemaId, CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID);
      assert.equal(ref.sourceSchemaId, "iris.pi_archive_entry.v1");
      assert.equal(ref.sourceId, "pi-entry-1");
      assert.equal(ref.sourceRevision, "7");
      assert.equal(ref.sourceHash, "entry-hash-1");

      // exactly-once：同一 source 幂等返回既有 Unit，不新增行。
      const again = ctx.irisContext.admitGenericRuntimeSource({
        sourceSchemaId: "iris.pi_archive_entry.v1",
        sourceId: "pi-entry-1",
        sourceRevision: "7",
        sourceHash: "entry-hash-1",
        contentSchemaId: "iris.semantic.context_message.user.v1",
        content: { role: "user", content: "pi hello" },
        runtimeSessionId: "pi-session-1",
        runtimeSourceKind: "user",
      });
      assert.equal(again.unitId, unit.unitId);
      assert.equal(
        ctx.irisContext.getStore().listContextUnits(lineageId, { disposition: "all" }).length,
        1,
      );
    } finally {
      await fiber.dispose();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("F4 sensitivity: Pi entry 伪装成 DshMessageRef 会失败（DSH ref 只来自真实 DSH）", () => {
  // admitRuntimeMessage 只接受 DSH session/message 语义；Pi 兼容路径必须用
  // admitGenericRuntimeSource。本门证明 Pi bridge 不在 DSH 入口。
  const servicePath = join(REPO_ROOT, "src", "cordis", "context-service.ts");
  const code = fs.readFileSync(servicePath, "utf8");
  // admitGenericRuntimeSource 存在且与 admitRuntimeMessage 分离（DSH-only）。
  assert.match(code, /admitGenericRuntimeSource/);
  assert.match(code, /admitRuntimeMessage/);
  // 通用入口明确使用 ContextUnitSourceRefV1（非 DshMessageRef）。
  const genericBlock = code.slice(code.indexOf("admitGenericRuntimeSource"));
  assert.ok(
    genericBlock.includes("CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID"),
    "admitGenericRuntimeSource must construct a generic ContextUnitSourceRefV1",
  );
  assert.ok(
    !genericBlock.slice(0, 1200).includes("DSH_MESSAGE_REF_V1_SCHEMA_ID"),
    "admitGenericRuntimeSource must not construct a DshMessageRef",
  );
});
