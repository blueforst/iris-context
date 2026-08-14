/**
 * Feature 3（iris-context#2）：current Context assembly 直接 ContextUnit[]。
 *
 * 证明：
 *  - buildContextGenerationV3 直接装配六层 ContextUnit[]（无
 *    ContextMessageUnit → ContextUnitV2 投影；无 generation-only 包装 DTO）；
 *  - P5 中出现的单元就是 admission 产生的同一个 ContextUnit（同一 unitId/
 *    contentHash —— 不复制、不重新包装）；
 *  - layerEnds 单调且 e5 === units.length；空层合法；
 *  - generation hash 确定性（等价 rebuild 同 hash；层边界/单元变化 → 不同 hash）；
 *  - 校验 fail-closed（篡改 generation hash / 未知单元 schemaId → invalid）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";

import { ContextAdmission } from "../src/context/context-admission.js";
import { ContextStore } from "../src/context/context-store.js";
import {
  buildContextGenerationV3,
  computeContextGenerationHashV3,
  unitsInLayerV3,
  validateContextGenerationV3,
} from "../src/context/generation-builder.js";
import {
  computeContextUnitContentHash,
  DSH_MESSAGE_REF_V1_SCHEMA_ID,
} from "../src/contracts/context-unit.js";
import { cleanupDir, makeLineageInput, tempDir } from "./helpers/context-fixtures.js";

const LINEAGE = "lineage-v3-assembly";

test("F3: buildContextGenerationV3 assembles ContextUnit[] directly (same P5 units, no projection)", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput("session-1", LINEAGE));
    const admission = new ContextAdmission(store);
    const u1 = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m1" },
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello" },
      runtimeSessionId: "session-1",
    });
    const u2 = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m2" },
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "again" },
      runtimeSessionId: "session-1",
    });

    const generation = buildContextGenerationV3(
      {
        contextLineageId: LINEAGE,
        sourceSnapshotHash: "snap-1",
        p0Units: [],
        p1Units: [],
        p2Units: [],
        p3Units: [],
        p4Units: [],
        p5Units: [u1, u2],
      },
      "gen-1",
      "2026-08-01T00:00:00.000Z",
    );
    assert.equal(generation.schemaId, "iris.context_generation.v3");
    assert.deepEqual([...generation.header.layerEnds], [0, 0, 0, 0, 0, 2]);
    // P5 单元就是 admission 的同一个 ContextUnit（同一 identity/content/hash）。
    const p5 = unitsInLayerV3(generation, 5);
    assert.deepEqual(
      p5.map((u) => u.unitId),
      [u1.unitId, u2.unitId],
    );
    assert.deepEqual(
      p5.map((u) => u.contentHash),
      [u1.contentHash, u2.contentHash],
    );
    assert.deepEqual(p5[0]?.content, u1.content);
    // 严格校验通过。
    assert.equal(validateContextGenerationV3(generation).valid, true);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F3: generation hash is deterministic and sensitive to layers/units", () => {
  const u1: import("../src/contracts/context-unit.js").ContextUnit = {
    schemaId: "iris.context_unit.v3",
    unitId: "u1",
    contextId: LINEAGE,
    contentSchemaId: "iris.semantic.context_message.user.v1",
    content: { role: "user", content: "x" },
    contentHash: "hash1",
    sourceRef: {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: "test",
      sourceId: "s1",
      sourceHash: "sh",
    },
  };
  const hashA = computeContextGenerationHashV3({
    schemaId: "iris.context_generation.v3",
    contextLineageId: LINEAGE,
    sourceSnapshotHash: "snap",
    units: [u1],
    layerEnds: [0, 0, 0, 0, 0, 1],
  });
  const hashB = computeContextGenerationHashV3({
    schemaId: "iris.context_generation.v3",
    contextLineageId: LINEAGE,
    sourceSnapshotHash: "snap",
    units: [u1],
    layerEnds: [0, 0, 0, 0, 0, 1],
  });
  assert.equal(hashA, hashB, "equivalent rebuild → same hash");
  const hashLayerChanged = computeContextGenerationHashV3({
    schemaId: "iris.context_generation.v3",
    contextLineageId: LINEAGE,
    sourceSnapshotHash: "snap",
    units: [u1],
    layerEnds: [0, 0, 0, 0, 1, 1],
  });
  assert.notEqual(hashA, hashLayerChanged, "layer boundary change → different hash");
  const hashUnitChanged = computeContextGenerationHashV3({
    schemaId: "iris.context_generation.v3",
    contextLineageId: LINEAGE,
    sourceSnapshotHash: "snap",
    units: [{ ...u1, contentHash: "hash2" }],
    layerEnds: [0, 0, 0, 0, 0, 1],
  });
  assert.notEqual(hashA, hashUnitChanged, "unit content hash change → different hash");
});

test("F3: validation fails closed on tampered generation hash and unknown unit schema", () => {
  const dir = tempDir();
  try {
    const store = ContextStore.open(join(dir, "context.db"), { lineageId: LINEAGE });
    store.createLineage(makeLineageInput("session-1", LINEAGE));
    const admission = new ContextAdmission(store);
    const u1 = admission.admit({
      sourceRef: { schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID, sessionId: "s1", messageId: "m1" },
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: { role: "user", content: "hello" },
      runtimeSessionId: "session-1",
    });
    const generation = buildContextGenerationV3(
      {
        contextLineageId: LINEAGE,
        sourceSnapshotHash: "snap",
        p0Units: [],
        p1Units: [],
        p2Units: [],
        p3Units: [],
        p4Units: [],
        p5Units: [u1],
      },
      "gen-1",
      "2026-08-01T00:00:00.000Z",
    );
    // 篡改 generation hash → fail-closed。
    const tampered = JSON.parse(JSON.stringify(generation)) as unknown as {
      header: { contextGenerationHash: string };
    };
    tampered.header.contextGenerationHash = "tampered";
    const r1 = validateContextGenerationV3(tampered);
    assert.ok(!r1.valid);
    assert.match(r1.reason ?? "", /contextGenerationHash mismatch/);

    // 篡改单元 schemaId → fail-closed。
    const tampered2 = JSON.parse(JSON.stringify(generation)) as typeof generation;
    (tampered2.units[0] as { schemaId: string }).schemaId = "iris.context_unit.v2";
    const r2 = validateContextGenerationV3(tampered2);
    assert.ok(!r2.valid);
    assert.match(r2.reason ?? "", /ContextUnit v3/);

    // 篡改单元 content（hash 未更新）→ fail-closed（unit 级 hash 校验）。
    const tampered3 = JSON.parse(JSON.stringify(generation)) as typeof generation;
    (tampered3.units[0] as unknown as { content: { content: string } }).content.content =
      "TAMPERED";
    const r3 = validateContextGenerationV3(tampered3);
    assert.ok(!r3.valid);
    assert.match(r3.reason ?? "", /contentHash mismatch/);
    store.close();
  } finally {
    cleanupDir(dir);
  }
});

test("F3: validation fails closed on duplicate unitIds (identity collapse)", () => {
  const makeUnit = (content: string): import("../src/contracts/context-unit.js").ContextUnit => {
    const sourceRef: import("../src/contracts/context-unit.js").ContextUnitSourceRef = {
      schemaId: "iris.context_unit_source_ref.v1",
      sourceSchemaId: "test",
      sourceId: "s1",
      sourceHash: "sh",
    };
    const payload = { role: "user", content };
    return {
      schemaId: "iris.context_unit.v3",
      unitId: "dup-unit",
      contextId: LINEAGE,
      contentSchemaId: "iris.semantic.context_message.user.v1",
      content: payload,
      contentHash: computeContextUnitContentHash({
        schemaId: "iris.context_unit.v3",
        unitId: "dup-unit",
        contextId: LINEAGE,
        contentSchemaId: "iris.semantic.context_message.user.v1",
        content: payload,
        sourceRef,
      }),
      sourceRef,
    };
  };
  // 同一 unitId（identity 塌缩）：每个单元单元级校验都通过（hash 正确），
  // 但 build 边界（与 validateContextGenerationV3 一致）必须拒绝重复 unitId。
  assert.throws(
    () =>
      buildContextGenerationV3(
        {
          contextLineageId: LINEAGE,
          sourceSnapshotHash: "snap",
          p0Units: [],
          p1Units: [],
          p2Units: [],
          p3Units: [],
          p4Units: [],
          p5Units: [makeUnit("x"), makeUnit("y")],
        },
        "gen-dup",
        "2026-08-01T00:00:00.000Z",
      ),
    /duplicate unitId/,
  );
});
