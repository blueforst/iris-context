import test from "node:test";

import assert from "node:assert/strict";

import {
  classifyEvidenceBasis,
  hasAnyDerivationRefs,
  isDerivedOnlyUnit,
  isEvidenceEligibleUnit,
  toEvidenceBasisRef,
  type HistorianUnitView,
} from "../src/historian/anti-echo.js";

function unitView(overrides: Partial<HistorianUnitView> = {}): HistorianUnitView {
  return {
    contextUnitId: "unit-1",
    contextSeq: 1,
    runtimeEventId: "evt-1",
    unitType: "input",
    disposition: "include",
    contentHash: "a".repeat(64),
    derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
    ...overrides,
  };
}

test("anti-echo: user input with no derivation refs is evidence-eligible", () => {
  const unit = unitView({ unitType: "input" });
  assert.equal(isDerivedOnlyUnit(unit), false);
  assert.equal(isEvidenceEligibleUnit(unit), true);
  const ref = toEvidenceBasisRef(unit);
  assert.ok(ref);
  assert.equal(ref?.historianDisposition, "include");
});

test("anti-echo: tool result is never derived-only", () => {
  const unit = unitView({
    unitType: "tool_result",
    derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextUnitIds: [] },
  });
  assert.equal(isDerivedOnlyUnit(unit), false);
  assert.equal(isEvidenceEligibleUnit(unit), true);
});

test("anti-echo: assistant restating recalled memory is derived-only and excluded", () => {
  const unit = unitView({
    unitType: "assistant",
    derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: ["comp-1"], sourceContextUnitIds: [] },
  });
  assert.equal(isDerivedOnlyUnit(unit), true);
  assert.equal(isEvidenceEligibleUnit(unit), false);
  assert.equal(toEvidenceBasisRef(unit), undefined);
});

test("anti-echo: reference_only disposition never becomes evidence basis", () => {
  const unit = unitView({ unitType: "input", disposition: "reference_only" });
  assert.equal(isEvidenceEligibleUnit(unit), false);
  assert.equal(toEvidenceBasisRef(unit), undefined);
});

test("anti-echo: exclude disposition never becomes evidence basis", () => {
  const unit = unitView({ unitType: "input", disposition: "exclude" });
  assert.equal(isEvidenceEligibleUnit(unit), false);
});

test("anti-echo: classifyEvidenceBasis keeps only eligible units", () => {
  const units = [
    unitView({ contextUnitId: "u1", contextSeq: 1, unitType: "input" }),
    unitView({
      contextUnitId: "u2",
      contextSeq: 2,
      unitType: "assistant",
      derivationRefs: { memoryRefs: ["mem-9"], compartmentIds: [], sourceContextUnitIds: [] },
    }),
    unitView({ contextUnitId: "u3", contextSeq: 3, unitType: "tool_result" }),
    unitView({
      contextUnitId: "u4",
      contextSeq: 4,
      unitType: "input",
      disposition: "reference_only",
    }),
  ];
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis(units);
  assert.equal(derivedOnly, false);
  assert.deepEqual(
    evidenceBasis.map((ref) => ref.contextUnitId),
    ["u1", "u3"],
  );
});

test("anti-echo: all-derived batch is marked derivedOnly", () => {
  const units = [
    unitView({
      contextUnitId: "e1",
      contextSeq: 1,
      unitType: "assistant",
      derivationRefs: { memoryRefs: ["mem-1"], compartmentIds: [], sourceContextUnitIds: [] },
    }),
    unitView({
      contextUnitId: "e2",
      contextSeq: 2,
      unitType: "assistant",
      derivationRefs: { memoryRefs: [], compartmentIds: ["comp-2"], sourceContextUnitIds: [] },
    }),
  ];
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis(units);
  assert.equal(derivedOnly, true);
  assert.equal(evidenceBasis.length, 0);
});

test("anti-echo: empty batch is derivedOnly (no new evidence)", () => {
  const { evidenceBasis, derivedOnly } = classifyEvidenceBasis([]);
  assert.equal(derivedOnly, true);
  assert.equal(evidenceBasis.length, 0);
});

test("anti-echo: hasAnyDerivationRefs covers workSnapshotVersion", () => {
  assert.equal(
    hasAnyDerivationRefs({
      memoryRefs: [],
      compartmentIds: [],
      sourceContextUnitIds: [],
      workSnapshotVersion: "v3",
    }),
    true,
  );
  assert.equal(
    hasAnyDerivationRefs({ memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] }),
    false,
  );
});
