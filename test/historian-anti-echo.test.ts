/**
 * Historian anti-echo 纯函数层测试（Phase D，provider-neutral）。
 *
 * 覆盖：isDerivedOnlyUnit / isEvidenceEligibleUnit / toEvidenceBasisRef /
 * classifyEvidenceBasis；derived-only 单元不产生新 evidence basis；批级
 * grounded-in-new-observations 语义。
 */
import test from "node:test";

import assert from "node:assert/strict";

import {
  classifyEvidenceBasis,
  hasAnyDerivationRefs,
  isDerivedOnlyUnit,
  isEvidenceEligibleUnit,
  toEvidenceBasisRef,
  unitViewOf,
} from "../src/historian/anti-echo.js";
import {
  STUB_LINEAGE_ID,
  emptyDerivationRefs,
  fixtureUnit,
} from "./helpers/historian-context-stub.js";

const USER_SCHEMA = "iris.semantic.context_message.user.v1";
const ASSISTANT_SCHEMA = "iris.semantic.context_message.assistant.v1";
const TOOL_SCHEMA = "iris.semantic.context_message.tool_result.v1";

function userUnit(seq: number, extra?: Partial<Parameters<typeof fixtureUnit>[0]>) {
  return fixtureUnit({
    contextSeq: seq,
    kind: "user",
    semanticSchemaId: USER_SCHEMA,
    semanticContent: { role: "user", content: `user ${seq}` },
    ...extra,
  });
}

function assistantUnit(seq: number, extra?: Partial<Parameters<typeof fixtureUnit>[0]>) {
  return fixtureUnit({
    contextSeq: seq,
    kind: "assistant",
    semanticSchemaId: ASSISTANT_SCHEMA,
    semanticContent: { role: "assistant", content: `assistant ${seq}` },
    ...extra,
  });
}

function toolUnit(seq: number, extra?: Partial<Parameters<typeof fixtureUnit>[0]>) {
  return fixtureUnit({
    contextSeq: seq,
    kind: "tool_result",
    semanticSchemaId: TOOL_SCHEMA,
    semanticContent: { role: "toolResult", content: `tool ${seq}` },
    ...extra,
  });
}

test("anti-echo: user/tool units are never derived-only; empty refs are empty", () => {
  const refs = emptyDerivationRefs();
  assert.equal(hasAnyDerivationRefs(refs), false);
  assert.equal(isDerivedOnlyUnit(unitViewOf(STUB_LINEAGE_ID, userUnit(1))), false);
  assert.equal(isDerivedOnlyUnit(unitViewOf(STUB_LINEAGE_ID, toolUnit(2))), false);
});

test("anti-echo: assistant with any derivation refs is derived-only", () => {
  const derived = assistantUnit(2, {
    derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", memoryRefs: ["mem-1"] },
  });
  assert.equal(isDerivedOnlyUnit(unitViewOf(STUB_LINEAGE_ID, derived)), true);
  const plain = assistantUnit(2, { derivationRefs: emptyDerivationRefs() });
  assert.equal(isDerivedOnlyUnit(unitViewOf(STUB_LINEAGE_ID, plain)), false);
});

test("anti-echo: only include + non-derived units are evidence-eligible", () => {
  assert.equal(isEvidenceEligibleUnit(unitViewOf(STUB_LINEAGE_ID, userUnit(1))), true);
  const referenceOnly = userUnit(1, { historianDisposition: "reference_only" });
  assert.equal(isEvidenceEligibleUnit(unitViewOf(STUB_LINEAGE_ID, referenceOnly)), false);
  const excluded = userUnit(1, { historianDisposition: "exclude" });
  assert.equal(isEvidenceEligibleUnit(unitViewOf(STUB_LINEAGE_ID, excluded)), false);
  const derived = assistantUnit(2, {
    derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", memoryRefs: ["m"] },
  });
  assert.equal(isEvidenceEligibleUnit(unitViewOf(STUB_LINEAGE_ID, derived)), false);
});

test("anti-echo: toEvidenceBasisRef is undefined for ineligible units; carries V1 shape", () => {
  const eligible = userUnit(1);
  const ref = toEvidenceBasisRef(STUB_LINEAGE_ID, unitViewOf(STUB_LINEAGE_ID, eligible));
  assert.ok(ref, "eligible user unit produces a basis ref");
  assert.equal(ref?.schemaId, "iris.evidence_basis_ref.v1");
  assert.equal(ref?.contextLineageId, STUB_LINEAGE_ID);
  assert.equal(ref?.contextUnitId, "unit-1");
  assert.equal(ref?.contextSeq, 1);
  assert.equal(ref?.historianDisposition, "include");

  const ineligible = assistantUnit(2, {
    derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", memoryRefs: ["m"] },
  });
  assert.equal(
    toEvidenceBasisRef(STUB_LINEAGE_ID, unitViewOf(STUB_LINEAGE_ID, ineligible)),
    undefined,
    "derived-only assistant produces no basis ref",
  );
  const referenceOnly = userUnit(1, { historianDisposition: "reference_only" });
  assert.equal(
    toEvidenceBasisRef(STUB_LINEAGE_ID, unitViewOf(STUB_LINEAGE_ID, referenceOnly)),
    undefined,
    "reference_only produces no basis ref",
  );
});

test("anti-echo: rawArchiveRef flows into the basis ref", () => {
  const unit = userUnit(1, {
    rawArchiveRef: {
      schemaId: "iris.raw_archive_ref.v1",
      runtimeSessionId: "s1",
      startEntrySeq: 1,
      endEntrySeq: 1,
    },
  });
  const ref = toEvidenceBasisRef(STUB_LINEAGE_ID, unitViewOf(STUB_LINEAGE_ID, unit));
  assert.ok(ref);
  assert.equal(ref?.rawArchiveRef?.schemaId, "iris.raw_archive_ref.v1");
});

test("anti-echo: batch classification — plain user+assistant produces basis, not derived-only", () => {
  const units = [userUnit(1), assistantUnit(2), userUnit(3)];
  const views = units.map((unit) => unitViewOf(STUB_LINEAGE_ID, unit));
  const classified = classifyEvidenceBasis(STUB_LINEAGE_ID, views);
  assert.equal(classified.derivedOnly, false);
  assert.ok(classified.evidenceBasis.length >= 2, "user + grounded assistant enter basis");
});

test("anti-echo: whole-batch echo (derived-only) produces no evidence", () => {
  const units = [
    assistantUnit(1, {
      derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", memoryRefs: ["m-1"] },
    }),
    assistantUnit(2, {
      derivationRefs: { schemaId: "iris.semantic_derivation_refs.v1", compartmentIds: ["c-1"] },
    }),
  ];
  const views = units.map((unit) => unitViewOf(STUB_LINEAGE_ID, unit));
  const classified = classifyEvidenceBasis(STUB_LINEAGE_ID, views);
  assert.equal(classified.evidenceBasis.length, 0);
  assert.equal(classified.derivedOnly, true, "derived-only batch yields no new evidence");
});

test("anti-echo: assistant grounded in a NEW in-batch observation is not derived-only", () => {
  const units = [
    userUnit(1), // new observation (no refs)
    assistantUnit(2, {
      derivationRefs: {
        schemaId: "iris.semantic_derivation_refs.v1",
        memoryRefs: ["m-1"],
        sourceContextMessageUnitIds: ["unit-1"],
      },
    }),
  ];
  const views = units.map((unit) => unitViewOf(STUB_LINEAGE_ID, unit));
  const classified = classifyEvidenceBasis(STUB_LINEAGE_ID, views);
  assert.equal(classified.derivedOnly, false, "grounded assistant is not echo");
  const assistantRef = classified.evidenceBasis.find((ref) => ref.contextUnitId === "unit-2");
  assert.ok(assistantRef, "grounded assistant enters the basis with its derivation audit trail");
  assert.ok(assistantRef?.derivationRefs, "derivationRefs preserved as audit");
});

test("anti-echo: reference_only/exclude never enter the basis even with refs", () => {
  const units = [
    userUnit(1, { historianDisposition: "reference_only" }),
    toolUnit(2, { historianDisposition: "exclude" }),
  ];
  const views = units.map((unit) => unitViewOf(STUB_LINEAGE_ID, unit));
  const classified = classifyEvidenceBasis(STUB_LINEAGE_ID, views);
  assert.equal(classified.evidenceBasis.length, 0, "no include unit → no basis");
  assert.equal(classified.derivedOnly, true);
});
