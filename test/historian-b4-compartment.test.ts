/**
 * Historian Feature B4（Phase D）—— CompartmentRevision 纯构造测试。
 *
 * 覆盖：lineage-scoped identity（compartment-{lineageId}-{seq}）、contextSeq
 * 坐标端点、sourceRangeHash 确定性、attribution roles 区分、episodeType
 * 枚举（无 continuity_transition）、anti-echo evidenceBasis/derivedOnly。
 */
import test from "node:test";

import assert from "node:assert/strict";

import { buildCompartment, compartmentRangeHash } from "../src/historian/historian-compartment.js";
import {
  STUB_LINEAGE_ID,
  emptyDerivationRefs,
  fixtureUnit,
} from "./helpers/historian-context-stub.js";

function units() {
  return [
    fixtureUnit({
      contextSeq: 1,
      kind: "user",
      semanticSchemaId: "iris.semantic.context_message.user.v1",
      semanticContent: { role: "user", content: "hello" },
    }),
    fixtureUnit({
      contextSeq: 2,
      kind: "assistant",
      semanticSchemaId: "iris.semantic.context_message.assistant.v1",
      semanticContent: { role: "assistant", content: "hi there" },
      derivationRefs: emptyDerivationRefs(),
    }),
    fixtureUnit({
      contextSeq: 3,
      kind: "tool_result",
      semanticSchemaId: "iris.semantic.context_message.tool_result.v1",
      semanticContent: { role: "toolResult", content: "ok" },
    }),
  ];
}

test("B4: compartment is lineage-scoped with contextSeq endpoints", () => {
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: units(),
  });
  assert.ok(built, "built compartment");
  if (built === null) return;
  assert.equal(built.compartment.compartmentId, `compartment-${STUB_LINEAGE_ID}-1`);
  assert.equal(built.compartment.lineageId, STUB_LINEAGE_ID);
  assert.equal(built.compartment.compartmentSequence, 1);
  assert.equal(built.compartment.startContextSeq, 1);
  assert.equal(built.compartment.endContextSeq, 3);
  assert.ok(built.compartment.content.includes("hello"));
  assert.ok(built.compartment.content.includes("hi there"));
});

test("B4: sourceRangeHash is deterministic and contextSeq-anchored", () => {
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: units(),
  });
  assert.ok(built);
  const h1 = compartmentRangeHash({
    lineageId: STUB_LINEAGE_ID,
    fromContextSeq: 1,
    throughContextSeq: 3,
    units: units(),
  });
  assert.equal(built?.compartment.sourceRangeHash, h1);
  const again = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: units(),
  });
  assert.equal(again?.compartment.sourceRangeHash, h1, "deterministic across builds");
});

test("B4: attribution roles stay distinct (user / iris_decision / tool_observation)", () => {
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: units(),
  });
  assert.ok(built);
  const roles = built?.attributionManifest.attributions.map((a) => a.role).sort();
  assert.deepEqual(roles, ["iris_decision", "tool_observation", "user"]);
  const userAttribution = built?.attributionManifest.attributions.find((a) => a.role === "user");
  assert.deepEqual(userAttribution?.contextUnitIds, ["unit-1"]);
});

test("B4: episodeType has no continuity_transition; tool batch → tool_execution", () => {
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: units(),
  });
  assert.ok(built);
  assert.equal(built?.compartment.episodeType, "tool_execution");
  const episodeTypes = ["request_response", "tool_execution", "maintenance"] as const;
  for (const episodeType of episodeTypes) {
    assert.ok(episodeTypes.includes(episodeType));
  }
  // v27：episodeType 枚举不含 continuity_transition。
  assert.equal(
    episodeTypes.includes("continuity_transition" as (typeof episodeTypes)[number]),
    false,
  );
});

test("B4: anti-echo — derived-only batch marks the compartment derivedOnly with no basis", () => {
  const echoUnits = [
    fixtureUnit({
      contextSeq: 1,
      kind: "assistant",
      semanticSchemaId: "iris.semantic.context_message.assistant.v1",
      semanticContent: { role: "assistant", content: "recall only" },
      derivationRefs: {
        schemaId: "iris.semantic_derivation_refs.v1",
        memoryRefs: ["mem-1"],
      },
    }),
  ];
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: echoUnits,
  });
  assert.ok(built);
  assert.equal(built?.derivedOnly, true);
  assert.equal(built?.evidenceBasis.length, 0);
});

test("B4: empty units → null (nothing to build)", () => {
  const built = buildCompartment({
    lineageId: STUB_LINEAGE_ID,
    runtimeSessionId: "session-1",
    compartmentSequence: 1,
    units: [],
  });
  assert.equal(built, null);
});
