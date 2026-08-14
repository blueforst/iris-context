/**
 * Phase E：P3 Compartment projection 单元测试。
 * 证明 committed Compartment 被确定性投影为 P0P1P2P3P4Unit：
 * contextUnitId=compartmentId、source 绑定 compartment/lineage/hash、
 * semanticSchemaId='iris.semantic.compartment.v1'、semanticContent 为结构化
 * 摘要；且投影结果能通过 buildContextGenerationV2 的严格校验（唯一
 * materializer）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  projectCommittedCompartment,
  compartmentSemanticContent,
} from "../src/context/p3-compartment.js";
import { buildContextGenerationV2, unitsInLayer } from "../src/context/generation-builder.js";
import { validateGenerationV2Strict } from "../src/contracts/context-v27.js";
import type { HistoricalCompartment } from "../src/historian/historian-compartment.js";

const LINEAGE = "lineage-p3-test";

function compartment(seq = 1): HistoricalCompartment {
  return {
    compartmentId: `compartment-${LINEAGE}-${seq}`,
    lineageId: LINEAGE,
    runtimeSessionId: "session-1",
    compartmentSequence: seq,
    startContextSeq: 1,
    endContextSeq: 3,
    sourceRangeHash: `range-hash-${seq}`,
    content: "user said hello\nassistant said hi",
    p1: "primary summary",
    p2: "",
    p3: "decision: use sqlite",
    p4: "open thread: migration",
    importance: "medium",
    episodeType: "request_response",
    attributionManifestId: `am-${LINEAGE}-${seq}`,
  };
}

test("P3: committed compartment projects to a deterministic P0P1P2P3P4Unit", () => {
  const unit = projectCommittedCompartment(compartment(1));
  assert.equal(unit.contextUnitId, `compartment-${LINEAGE}-1`);
  assert.equal(unit.semanticSchemaId, "iris.semantic.compartment.v1");
  assert.equal(unit.source.sourceSchemaId, "iris.committed_compartment.v1");
  assert.equal(unit.source.sourceId, `compartment-${LINEAGE}-1`);
  assert.equal(unit.source.sourceRevision, "1");
  assert.equal(unit.source.sourceHash, "range-hash-1");
  const content = unit.semanticContent as Record<string, unknown>;
  assert.equal(content["schemaId"], "iris.semantic.compartment.v1");
  assert.equal(content["compartmentSequence"], 1);
  assert.equal(content["startContextSeq"], 1);
  assert.equal(content["endContextSeq"], 3);
  assert.equal(content["sourceRangeHash"], "range-hash-1");
  assert.equal(content["importance"], "medium");
  assert.equal(content["episodeType"], "request_response");
  assert.equal(content["content"], "user said hello\nassistant said hi");
  assert.equal(content["primarySummary"], "primary summary");
  assert.equal(content["decisions"], "decision: use sqlite");
  assert.equal(content["openThreads"], "open thread: migration");
});

test("P3: two compartments project in deterministic sequence order and pass strict validation", () => {
  const c1 = projectCommittedCompartment(compartment(1));
  const c2 = projectCommittedCompartment(compartment(2));
  assert.equal(c1.contextUnitId < c2.contextUnitId, true, "sequence order preserved");
  const generation = buildContextGenerationV2(
    {
      contextLineageId: LINEAGE,
      sourceSnapshotHash: "snap-p3",
      p0Units: [],
      p1Units: [],
      p2Units: [],
      p3Units: [c1, c2],
      p4Units: [],
      p5Units: [],
    },
    "gen-p3-1",
    "2026-08-01T00:00:00.000Z",
  );
  // P3 layer = [layerEnds[2], layerEnds[3])
  const p3 = unitsInLayer(generation, 3);
  assert.equal(p3.length, 2);
  assert.equal(p3[0]?.header.contextUnitId, `compartment-${LINEAGE}-1`);
  assert.equal(p3[1]?.header.contextUnitId, `compartment-${LINEAGE}-2`);
  const check = validateGenerationV2Strict(generation);
  assert.equal(check.valid, true, check.reason ?? "compartment projection must validate");
});

test("P3: compartmentSemanticContent is a strict iris.semantic.compartment.v1 payload", () => {
  const content = compartmentSemanticContent(compartment(1)) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(content).sort(),
    [
      "compartmentId",
      "compartmentSequence",
      "content",
      "decisions",
      "endContextSeq",
      "episodeType",
      "importance",
      "lineageId",
      "openThreads",
      "primarySummary",
      "schemaId",
      "secondarySummary",
      "sourceRangeHash",
      "startContextSeq",
    ].sort(),
  );
});
