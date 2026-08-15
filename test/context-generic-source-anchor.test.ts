/**
 * Feature 1（iris-context#4）+ A1：generic source admission identity /
 * exactly-once anchor 修复测试。
 *
 * 背景：旧 `deriveContextUnitId()` 用 `|` 拼接、`genericSourceAnchor()` /
 * `dshSourceAnchor()` 用 `:` 拼接 source 字段。任意 source 字段可包含这些
 * 字符 → 确定性序列化碰撞（例如 sourceId="a|b" + revision=undefined 与
 * sourceId="a" + revision="b" 撞同一 unitId）。
 *
 * A1 修复：单一版本化 canonical identity encoder（`sourceIdentityFields` /
 * `sourceIdentityBasis`，src/contracts/context-unit.ts）用 canonical JSON
 * 数组编码，无分隔符歧义；unitId 与 exactly-once 锚共享同一字段规则；
 * locator（eventSeq/entrySeq）不进入稳定 identity。
 *
 * 覆盖（A1 AC）：
 *  - sourceId 含 "|" / ":" / Unicode / emoji / combining characters 无碰撞；
 *  - sourceRevision 与 sourceId 的分段边界不可交换（"a|b"/undef vs "a"/"b"）；
 *  - 空 optional revision（""）与不存在 revision（undefined）可区分；
 *  - 相同 hash、不同 source identity → 不同 unitId/anchor；
 *  - 相同 source identity、不同 revision → 不同 unitId/anchor；
 *  - 同一 source identity + 同一 revision/hash → 幂等同一锚/同一 Unit；
 *  - restart + SQLite 持久化：reopen 后两个 revision 的 Unit/ordering 保留；
 *  - 旧 data root（以旧派生写入的行）可打开并幂等解析（compatibility lookup）；
 *  - sensitivity gate：identity 字段规则回归（丢失 revision/hash）失败。
 */
import { join } from "node:path";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

import {
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  computeContextUnitContentHash,
  deriveContextUnitId,
  sourceAnchorOf,
  sourceIdentityFields,
} from "../src/contracts/context-unit.js";
import { ContextAdmission, genericSourceAnchor } from "../src/context/context-admission.js";
import { ContextStore } from "../src/context/context-store.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";

const LINEAGE = "identity-f1-anchor";
const COMPARTMENT_CONTENT_SCHEMA = "iris.semantic.compartment.v1";

/** 构造一个通用（P0–P4/派生）sourceRef + 合法 compartment content。 */
function genericSourceRef(input: { sourceId: string; revision?: string; hash: string }): {
  schemaId: "iris.context_unit_source_ref.v1";
  sourceSchemaId: string;
  sourceId: string;
  sourceRevision?: string;
  sourceHash: string;
} {
  return {
    schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
    sourceSchemaId: "iris.committed_compartment.v1",
    sourceId: input.sourceId,
    ...(input.revision !== undefined ? { sourceRevision: input.revision } : {}),
    sourceHash: input.hash,
  };
}

function compartmentContent(compartmentId: string, seq: number, summary: string): unknown {
  return {
    schemaId: "iris.semantic.compartment.v1",
    compartmentId,
    compartmentSequence: seq,
    lineageId: LINEAGE,
    startContextSeq: 1,
    endContextSeq: seq,
    sourceRangeHash: `range-${compartmentId}-${seq}`,
    importance: "medium",
    episodeType: "request_response",
    content: summary,
    primarySummary: summary,
    secondarySummary: summary,
    decisions: summary,
    openThreads: summary,
  };
}

function openStore(dir: string): ContextStore {
  const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
  store.createLineage(makeLineageInput("session-1", LINEAGE));
  return store;
}

// ---------------------------------------------------------------------------
// A1 对抗性编码：无歧义 identity（unitId 与 anchor 共享字段规则）
// ---------------------------------------------------------------------------

test("A1: sourceId containing '|' cannot collide with a revision boundary swap", () => {
  // 回归：旧 `|` 拼接下 sourceId="a|b"+undef 与 sourceId="a"+rev="b" 撞同一 unitId。
  const pipe1 = genericSourceRef({ sourceId: "a|b", hash: "h" });
  const pipe2 = genericSourceRef({ sourceId: "a", revision: "b", hash: "h" });
  assert.notEqual(deriveContextUnitId(LINEAGE, pipe1), deriveContextUnitId(LINEAGE, pipe2));
  assert.notEqual(sourceAnchorOf(pipe1), sourceAnchorOf(pipe2));
  assert.notEqual(genericSourceAnchor(pipe1), genericSourceAnchor(pipe2));
});

test("A1: sourceId containing ':' cannot collide with a revision boundary swap", () => {
  const colon1 = genericSourceRef({ sourceId: "a:b", hash: "h" });
  const colon2 = genericSourceRef({ sourceId: "a", revision: "b", hash: "h" });
  assert.notEqual(deriveContextUnitId(LINEAGE, colon1), deriveContextUnitId(LINEAGE, colon2));
  assert.notEqual(sourceAnchorOf(colon1), sourceAnchorOf(colon2));
});

test("A1: Unicode / emoji / combining characters are unambiguous identity content", () => {
  const emoji1 = genericSourceRef({ sourceId: "🔍\u0301", revision: "r", hash: "h" });
  const emoji2 = genericSourceRef({ sourceId: "🔍", revision: "\u0301r", hash: "h" });
  assert.notEqual(deriveContextUnitId(LINEAGE, emoji1), deriveContextUnitId(LINEAGE, emoji2));
  // 同一 source → 确定性同一 identity（跨 restart 稳定）。
  assert.equal(
    deriveContextUnitId(LINEAGE, emoji1),
    deriveContextUnitId(
      LINEAGE,
      genericSourceRef({ sourceId: "🔍\u0301", revision: "r", hash: "h" }),
    ),
  );
});

test("A1: empty optional revision ('') is distinct from a missing revision (undefined)", () => {
  const missing = genericSourceRef({ sourceId: "comp-1", hash: "h" });
  const empty = genericSourceRef({ sourceId: "comp-1", revision: "", hash: "h" });
  assert.notEqual(deriveContextUnitId(LINEAGE, missing), deriveContextUnitId(LINEAGE, empty));
  assert.notEqual(sourceAnchorOf(missing), sourceAnchorOf(empty));
});

test("A1: same hash, different source identity → different unitId and anchor", () => {
  const one = genericSourceRef({ sourceId: "s1", hash: "H" });
  const two = genericSourceRef({ sourceId: "s2", hash: "H" });
  assert.notEqual(deriveContextUnitId(LINEAGE, one), deriveContextUnitId(LINEAGE, two));
  assert.notEqual(sourceAnchorOf(one), sourceAnchorOf(two));
});

test("A1: same source identity, different revision → different unitId and anchor", () => {
  const r1 = genericSourceRef({ sourceId: "s1", revision: "r1", hash: "h1" });
  const r2 = genericSourceRef({ sourceId: "s1", revision: "r2", hash: "h1" });
  assert.notEqual(deriveContextUnitId(LINEAGE, r1), deriveContextUnitId(LINEAGE, r2));
  assert.notEqual(sourceAnchorOf(r1), sourceAnchorOf(r2));
});

// ---------------------------------------------------------------------------
// 锚语义（单元级）：确定性 + revision/hash 区分 + 幂等
// ---------------------------------------------------------------------------

test("F1: same source identity + same revision/hash → same anchor (idempotent)", () => {
  const a = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
  const b = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
  assert.equal(genericSourceAnchor(a), genericSourceAnchor(b));
  assert.equal(sourceAnchorOf(a), sourceAnchorOf(b));
  // 与 unitId 共享同一 identity 字段规则（versioned canonical basis）。
  assert.equal(sourceIdentityFields(a).length, 4, "stable+revision fields, no locator");
});

test("F1: changed revision → different anchor", () => {
  const r1 = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
  const r2 = genericSourceRef({ sourceId: "comp-1", revision: "r2", hash: "h2" });
  assert.notEqual(genericSourceAnchor(r1), genericSourceAnchor(r2));
});

test("F1: changed hash alone → different anchor", () => {
  const h1 = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
  const h2 = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h2" });
  assert.notEqual(genericSourceAnchor(h1), genericSourceAnchor(h2));
});

test("F1: revision-absent form is deterministic and distinguishable", () => {
  const noRev = genericSourceRef({ sourceId: "comp-1", hash: "h1" });
  assert.equal(genericSourceAnchor(noRev), sourceAnchorOf(noRev));
  assert.notEqual(
    genericSourceAnchor(noRev),
    genericSourceAnchor(genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" })),
  );
});

// ---------------------------------------------------------------------------
// 持久化级：revision A / revision B 共存 + accepted ordering + restart
// ---------------------------------------------------------------------------

test("F1: two revisions of the same generic source coexist as distinct units across restart", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);

    // revision A（sourceId 相同，revision/hash 不同）。
    const refA = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
    const unitA = admission.admit({
      sourceRef: refA,
      contentSchemaId: COMPARTMENT_CONTENT_SCHEMA,
      content: compartmentContent("comp-1", 1, "revision A summary") as never,
    });
    // revision B —— 同一 sourceSchemaId/sourceId，新 revision/hash。
    const refB = genericSourceRef({ sourceId: "comp-1", revision: "r2", hash: "h2" });
    const unitB = admission.admit({
      sourceRef: refB,
      contentSchemaId: COMPARTMENT_CONTENT_SCHEMA,
      content: compartmentContent("comp-1", 2, "revision B summary") as never,
    });

    // 不同 revision → 不同 unitId（新逻辑 Unit），且锚不同（不撞 UNIQUE）。
    assert.notEqual(unitA.unitId, unitB.unitId);
    assert.notEqual(genericSourceAnchor(refA), genericSourceAnchor(refB));
    // unitId 与 identity 派生一致（anchor 修复不得与 deriveContextUnitId 分叉）。
    assert.equal(unitA.unitId, deriveContextUnitId(LINEAGE, refA));
    assert.equal(unitB.unitId, deriveContextUnitId(LINEAGE, refB));

    // accepted ordering：monotonic contextSeq（A < B）。
    const all = store.listContextUnits(LINEAGE, { disposition: "all" });
    assert.equal(all.length, 2);
    const withState = store.listContextUnitsWithState(LINEAGE, 0, Number.MAX_SAFE_INTEGER);
    const seqByUnit = new Map(withState.map(({ unit, state }) => [unit.unitId, state.contextSeq]));
    const seqA = seqByUnit.get(unitA.unitId);
    const seqB = seqByUnit.get(unitB.unitId);
    assert.ok(seqA !== undefined && seqB !== undefined);
    assert.ok(seqA < seqB, `accepted ordering must be monotonic (${seqA} < ${seqB})`);

    // 重新接纳同一 revision A（同一 source identity）→ 幂等返回既有 Unit，
    // 不新增行（exactly-once 不被弱化）。
    const againA = admission.admit({
      sourceRef: genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" }),
      contentSchemaId: COMPARTMENT_CONTENT_SCHEMA,
      content: compartmentContent("comp-1", 1, "revision A summary") as never,
    });
    assert.equal(againA.unitId, unitA.unitId);
    assert.equal(store.listContextUnits(LINEAGE, { disposition: "all" }).length, 2);

    store.close();

    // restart：重开 DB 后两个 revision 的 Unit 与 accepted ordering 保留。
    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const reloaded = reopened.listContextUnits(LINEAGE, { disposition: "all" });
    assert.equal(reloaded.length, 2);
    const ids = reloaded.map((u) => u.unitId).sort();
    assert.deepEqual(ids, [unitA.unitId, unitB.unitId].sort());
    const reloadedWithState = reopened.listContextUnitsWithState(
      LINEAGE,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const reloadedSeqByUnit = new Map(
      reloadedWithState.map(({ unit, state }) => [unit.unitId, state.contextSeq]),
    );
    assert.equal(reloadedSeqByUnit.get(unitA.unitId), seqA);
    assert.equal(reloadedSeqByUnit.get(unitB.unitId), seqB);
    const reloadedA = reopened.getContextUnitByUnitId(LINEAGE, unitA.unitId);
    assert.equal(reloadedA?.contentHash, unitA.contentHash);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// A1：旧 data root 兼容（compatibility lookup）—— 旧派生写入的行可幂等解析
// ---------------------------------------------------------------------------

test("A1: old data root (pre-upgrade unitId/anchor derivation) re-admits idempotently", () => {
  const dir = tempDir();
  try {
    const store = openStore(dir);
    const admission = new ContextAdmission(store);
    // 以**新**编码接纳一个 source（升级后的第一行）。
    const ref = genericSourceRef({ sourceId: "comp-9", revision: "r1", hash: "h1" });
    const unit = admission.admit({
      sourceRef: ref,
      contentSchemaId: COMPARTMENT_CONTENT_SCHEMA,
      content: compartmentContent("comp-9", 1, "summary") as never,
    });
    const newAnchor = store
      .listContextUnitsWithState(LINEAGE, 0, Number.MAX_SAFE_INTEGER)
      .find(({ unit: u }) => u.unitId === unit.unitId)?.state?.sourceAnchor;
    assert.ok(newAnchor?.startsWith("src-") === true, "new anchor format");
    store.close();

    // 模拟旧 data root：把该行的 unit_id/source_event_id 改写为旧派生格式
    // （旧 unitId 格式 / 旧 `:` 拼接锚），并按旧 unitId 重算 content_hash
    // （contentHash 的 canonical basis 覆盖 unitId —— 旧行内部必须自洽），
    // 然后重开 —— 新代码 re-admit 同一 source 必须经 compatibility lookup
    // 幂等解析回同一行，而不是新建重复行。
    const raw = new DatabaseSync(join(dir, "context.db"));
    const oldUnitId = `unit-${"0".repeat(16)}`;
    const oldHash = computeContextUnitContentHash({
      schemaId: "iris.context_unit.v3",
      unitId: oldUnitId,
      contextId: LINEAGE,
      contentSchemaId: COMPARTMENT_CONTENT_SCHEMA,
      content: compartmentContent("comp-9", 1, "summary") as never,
      sourceRef: ref,
    });
    raw
      .prepare(
        `UPDATE context_units SET unit_id = ?, source_event_id = ?, content_hash = ?
         WHERE context_lineage_id = ?`,
      )
      .run(oldUnitId, "iris.committed_compartment.v1:comp-9:r1:h1", oldHash, LINEAGE);
    raw.close();

    const reopened = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    const admission2 = new ContextAdmission(reopened);
    const again = admission2.admit({
      sourceRef: genericSourceRef({ sourceId: "comp-9", revision: "r1", hash: "h1" }),
      contentSchemaId: COMPARTMENT_CONTENT_SCHEMA,
      content: compartmentContent("comp-9", 1, "summary") as never,
    });
    // 幂等：解析回被改写的旧行（同一 canonical semantic content —— 旧行的
    // contentHash 基于旧 unitId，因此语义内容比较而非 hash 比较），而不是
    // 新建重复 Unit。
    assert.equal(again.unitId, oldUnitId, "compatibility lookup must resolve the legacy row");
    assert.deepEqual(again.content, unit.content, "legacy row keeps the same semantic content");
    assert.equal(reopened.listContextUnits(LINEAGE, { disposition: "all" }).length, 1);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// sensitivity gate：identity 字段规则回归（丢失 revision/hash）失败
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTEXT_UNIT_FILE = path.join(REPO_ROOT, "src", "contracts", "context-unit.ts");

test("F1 sensitivity: sourceIdentityFields must incorporate sourceRevision and sourceHash", () => {
  const code = fs.readFileSync(CONTEXT_UNIT_FILE, "utf8");
  const startMarker = "export function sourceIdentityFields(";
  const start = code.indexOf(startMarker);
  assert.ok(start >= 0, "sourceIdentityFields must exist in context-unit.ts");
  const bodyStart = code.indexOf("{", start);
  const bodyEnd = code.indexOf("\n}", bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "sourceIdentityFields body must be extractable");
  const body = code.slice(bodyStart, bodyEnd);

  // 通用 source 分支必须引用 sourceRevision / sourceHash（回归到只取
  // sourceSchemaId+sourceId 必须失败）。
  assert.match(
    body,
    /sourceRevision/,
    "sourceIdentityFields must reference sourceRevision (regression must fail CI)",
  );
  assert.match(
    body,
    /sourceHash/,
    "sourceIdentityFields must reference sourceHash (regression must fail CI)",
  );
  // 禁止 `|` / `:` 拼接回归。
  assert.doesNotMatch(body, /\|/, "identity fields must not be joined with '|'");
  assert.doesNotMatch(body, /\.join\(":"\)/, "identity fields must not be joined with ':'");
});

test("F1 sensitivity: unitId derivation and anchor share sourceIdentityFields (no duplicated rules)", () => {
  const code = fs.readFileSync(CONTEXT_UNIT_FILE, "utf8");
  // 派生函数都引用共享的 sourceIdentityFields，而不是复制字段清单。
  const derive = code.indexOf("export function deriveContextUnitId(");
  const deriveBody = code.slice(derive, code.indexOf("\n}", derive));
  assert.match(
    deriveBody,
    /sourceIdentityFields/,
    "deriveContextUnitId must delegate to the shared identity fields",
  );
  const anchor = code.indexOf("export function sourceAnchorOf(");
  const anchorBody = code.slice(anchor, code.indexOf("\n}", anchor));
  assert.match(
    anchorBody,
    /sourceIdentityBasis/,
    "sourceAnchorOf must delegate to the shared identity basis",
  );
});
