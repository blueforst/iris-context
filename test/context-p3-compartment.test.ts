/**
 * Phase E + iris-context#2：P3 Compartment projection 单元测试。
 * 证明 committed Compartment 被确定性投影为中性 AdmissionCandidate，经 Context
 * admission materialize 为新的 ContextUnit C1（不是把旧 Unit 改造成
 * CompartmentUnit）：
 * - sourceRef 绑定 compartment/lineage/hash；contentSchemaId=
 *   'iris.semantic.compartment.v1'；content 为结构化摘要；
 * - coveredUnitIds → derivation.sourceContextMessageUnitIds（immutable basis）；
 * - materialize 后的 ContextUnit 能通过 buildContextGenerationV3 严格校验。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  projectCommittedCompartmentCandidate,
  compartmentSemanticContent,
} from "../src/context/p3-compartment.js";
import { materializeContextUnit } from "../src/context/context-admission.js";
import { buildContextGenerationV3, unitsInLayerV3 } from "../src/context/generation-builder.js";
import { validateContextGenerationV3 } from "../src/context/generation-builder.js";
import { validateContextUnitStrict } from "../src/contracts/context-unit.js";
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

test("F3: committed compartment projects to a deterministic AdmissionCandidate", () => {
  const candidate = projectCommittedCompartmentCandidate(compartment(1));
  assert.equal(candidate.sourceRef.schemaId, "iris.context_unit_source_ref.v1");
  assert.equal(candidate.sourceRef.sourceSchemaId, "iris.committed_compartment.v1");
  assert.equal(candidate.sourceRef.sourceId, `compartment-${LINEAGE}-1`);
  assert.equal(candidate.sourceRef.sourceRevision, "1");
  assert.equal(candidate.sourceRef.sourceHash, "range-hash-1");
  assert.equal(candidate.contentSchemaId, "iris.semantic.compartment.v1");
  assert.equal(candidate.derivation, undefined, "no basis without coveredUnitIds");
  const content = candidate.content as Record<string, unknown>;
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

test("F3: covered unit ids become immutable basis refs (new ContextUnit, not retype)", () => {
  const candidate = projectCommittedCompartmentCandidate(compartment(1), [
    "input-e1",
    "assistant-e2",
  ]);
  assert.deepEqual(
    candidate.derivation?.sourceContextMessageUnitIds,
    ["input-e1", "assistant-e2"],
    "basis refs reference the covered OLD units (U1,U2,U3) — the Compartment is a NEW source",
  );
  // Context admission materialize 为一个新的 ContextUnit C1。
  const unit = materializeContextUnit(LINEAGE, candidate);
  assert.equal(unit.schemaId, "iris.context_unit.v3");
  assert.equal(validateContextUnitStrict(unit).valid, true);
  assert.deepEqual(unit.derivation?.sourceContextMessageUnitIds, ["input-e1", "assistant-e2"]);
  // 同一 compartment → 同一逻辑 Unit（确定性 identity）。
  const again = materializeContextUnit(
    LINEAGE,
    projectCommittedCompartmentCandidate(compartment(1), ["input-e1", "assistant-e2"]),
  );
  assert.equal(again.unitId, unit.unitId);
});

test("F3: two compartments materialize in deterministic order and pass v3 generation validation", () => {
  const c1 = materializeContextUnit(LINEAGE, projectCommittedCompartmentCandidate(compartment(1)));
  const c2 = materializeContextUnit(LINEAGE, projectCommittedCompartmentCandidate(compartment(2)));
  const generation = buildContextGenerationV3(
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
  const p3 = unitsInLayerV3(generation, 3);
  assert.equal(p3.length, 2);
  assert.equal(p3[0]?.unitId, c1.unitId);
  assert.equal(p3[1]?.unitId, c2.unitId);
  const check = validateContextGenerationV3(generation);
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
