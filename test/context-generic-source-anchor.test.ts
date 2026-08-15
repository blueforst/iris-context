/**
 * Feature 1（iris-context#4）：generic source admission identity /
 * exactly-once anchor 修复测试。
 *
 * 背景：`genericSourceAnchor()` 原先只返回 `${sourceSchemaId}:${sourceId}`，
 * 但当前 ContextUnit identity（`deriveContextUnitId()`）对通用 source 包含
 * `sourceRevision?` 与 `sourceHash`。因此同一 source 的两个不同合法 revision
 * 会派生不同 unitId，却共享同一 sourceAnchor —— 第二次 admission 在持久层
 * `source_event_id UNIQUE` 上碰撞，而不是材料化新 Unit 所需的 ContextUnit。
 *
 * 覆盖（iris-context#4 AC）：
 *  - 同一 sourceSchemaId/sourceId + 同一 revision/hash → 幂等同一锚/同一 Unit；
 *  - 同一 sourceSchemaId/sourceId + 新 revision/hash → 新锚 → 新 ContextUnit
 *    → 新 accepted ordering（不撞 source_event_id UNIQUE）；
 *  - restart + SQLite 持久化：reopen 后两个 revision 的 Unit 与 ordering 保留；
 *  - sensitivity gate：回归到 `${sourceSchemaId}:${sourceId}` 的锚格式失败。
 */
import { join } from "node:path";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";

import {
  CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
  deriveContextUnitId,
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
// 锚语义（单元级）：确定性 + revision/hash 区分 + 幂等
// ---------------------------------------------------------------------------

test("F1: same source identity + same revision/hash → same anchor (idempotent)", () => {
  const a = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
  const b = genericSourceRef({ sourceId: "comp-1", revision: "r1", hash: "h1" });
  assert.equal(genericSourceAnchor(a), genericSourceAnchor(b));
  assert.equal(genericSourceAnchor(a), "iris.committed_compartment.v1:comp-1:r1:h1");
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
  assert.equal(genericSourceAnchor(noRev), "iris.committed_compartment.v1:comp-1:h1");
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
// sensitivity gate：回归到 `${sourceSchemaId}:${sourceId}` 的锚格式失败
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const ADMISSION_FILE = path.join(REPO_ROOT, "src", "context", "context-admission.ts");

test("F1 sensitivity: genericSourceAnchor must incorporate sourceRevision and sourceHash", () => {
  const code = fs.readFileSync(ADMISSION_FILE, "utf8");
  // 提取 genericSourceAnchor 函数体（从函数声明到第一个闭合的 "}"，仅取首个
  // 匹配 —— 该函数体很短且无嵌套大括号）。
  const startMarker = "export function genericSourceAnchor(";
  const start = code.indexOf(startMarker);
  assert.ok(start >= 0, "genericSourceAnchor must exist in context-admission.ts");
  const bodyStart = code.indexOf("{", start);
  const bodyEnd = code.indexOf("\n}", bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "genericSourceAnchor body must be extractable");
  const body = code.slice(bodyStart, bodyEnd);

  // 回归到 `${ref.sourceSchemaId}:${ref.sourceId}` 时，body 不再引用
  // sourceRevision / sourceHash —— 本门失败。
  assert.match(
    body,
    /sourceRevision/,
    "genericSourceAnchor must reference sourceRevision (regression to " +
      "`${sourceSchemaId}:${sourceId}` must fail CI)",
  );
  assert.match(
    body,
    /sourceHash/,
    "genericSourceAnchor must reference sourceHash (regression to " +
      "`${sourceSchemaId}:${sourceId}` must fail CI)",
  );
  // 显式禁止裸的 `${ref.sourceSchemaId}:${ref.sourceId}` 直接返回形式。
  assert.doesNotMatch(
    body,
    /return\s*`\$\{ref\.sourceSchemaId\}:\$\{ref\.sourceId\}`/,
    "genericSourceAnchor must not regress to the revision-blind anchor",
  );
});
