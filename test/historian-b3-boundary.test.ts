/**
 * Historian Feature B3（Phase D）—— PURE range validation + lineage clamp。
 *
 * 覆盖：validateRange（claim anchor、range hash 不变量、no_safe_prefix、
 * 内容漂移 fail-closed）、clampBatchWindow / clampEligibleThroughContextSeq。
 */
import test from "node:test";

import assert from "node:assert/strict";

import { validateRange } from "../src/historian/historian-analysis.js";
import {
  clampBatchWindow,
  clampEligibleThroughContextSeq,
} from "../src/historian/historian-boundary.js";
import { historianBatchRangeHash } from "../src/contracts/historian.js";
import { STUB_LINEAGE_ID, simpleUnits } from "./helpers/historian-context-stub.js";

function batchOf(units = simpleUnits(3)): Parameters<typeof validateRange>[0]["batch"] {
  const from = units[0]?.contextSeq ?? 1;
  const through = units[units.length - 1]?.contextSeq ?? from;
  return {
    schemaId: "iris.historian_batch.v2",
    batchId: `batch-${STUB_LINEAGE_ID}-${from}-${through}`,
    claimId: "claim-1",
    contextLineageId: STUB_LINEAGE_ID,
    fromContextSeq: from,
    throughContextSeq: through,
    rangeHash: "",
    semanticSchemaIds: [],
    units,
    estimatedTokens: 1,
    frozenAt: "2026-08-01T00:00:00.000Z",
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
  };
}

test("B3: validateRange accepts a valid frozen batch anchored at the cursor", () => {
  const units = simpleUnits(3);
  const batch = batchOf(units);
  batch.rangeHash = historianBatchRangeHash(batch);
  const outcome = validateRange({ batch, unprocessedFromContextSeq: 1 });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.commitThroughContextSeq, 3);
  }
});

test("B3: claim anchor mismatch fails closed (batch must start after the cursor)", () => {
  const units = simpleUnits(3);
  const batch = batchOf(units);
  batch.rangeHash = historianBatchRangeHash(batch);
  const outcome = validateRange({ batch, unprocessedFromContextSeq: 2 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.errorCode, "claim_anchor_mismatch");
  }
});

test("B3: content drift → range hash mismatch fails closed (never commit drift)", () => {
  const units = simpleUnits(3);
  const batch = batchOf(units);
  batch.rangeHash = historianBatchRangeHash(batch);
  // 篡改一个单元的内容 hash（模拟 Content drift）。
  const tampered = {
    ...units[1],
    unit: { ...units[1]?.unit, contentHash: "tampered" },
  } as (typeof units)[number];
  const first = units[0];
  const third = units[2];
  assert.ok(first !== undefined && third !== undefined, "fixture units 1 and 3 present");
  const drifted = batchOf([first, tampered, third]);
  drifted.rangeHash = batch.rangeHash; // 保留冻结 hash
  const outcome = validateRange({ batch: drifted, unprocessedFromContextSeq: 1 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.errorCode, "source_range_hash_mismatch");
  }
});

test("B3: empty window → no_safe_prefix (never advances the cursor)", () => {
  const batch = batchOf([]);
  batch.rangeHash = historianBatchRangeHash(batch);
  const outcome = validateRange({ batch, unprocessedFromContextSeq: 1 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.errorCode, "no_safe_prefix");
  }
});

test("B3: lineage clamp — eligible ceiling never exceeds the materialization watermark", () => {
  assert.equal(clampEligibleThroughContextSeq(10, { representedThroughContextSeq: 7 }), 7);
  assert.equal(clampEligibleThroughContextSeq(10, { representedThroughContextSeq: null }), 10);
  assert.equal(clampEligibleThroughContextSeq(10, undefined), 10);
  const window = clampBatchWindow({
    fromContextSeq: 5,
    throughContextSeq: 10,
    lineage: { representedThroughContextSeq: 4 },
  });
  assert.equal(window.windowEmpty, true, "clamped below from → empty window");
  assert.equal(window.eligibleThroughContextSeq, 0);
});
