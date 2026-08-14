/**
 * Historian R3 Exit Gate 4（Phase D）—— hot-row reclaim 纯逻辑测试。
 *
 * 覆盖：四条件判定（context_ack / bust_represented / memory_durable_ack +
 * 已验证绑定 receipt / shard_verified）、可释放集合、shard seal 确定性。
 */
import test from "node:test";

import assert from "node:assert/strict";

import {
  deriveShardId,
  eligibleForReclaim,
  isReclaimEligible,
  sealShardContent,
  withBustRepresented,
  withContextAck,
  withMemoryDurableAck,
  withShardVerified,
  type CompartmentReleaseView,
} from "../src/historian/hot-row-reclaim.js";

function baseView(compartmentSequence: number): CompartmentReleaseView {
  return {
    compartmentId: `compartment-l-${compartmentSequence}`,
    runtimeSessionId: "l",
    compartmentSequence,
    startContextSeq: 1,
    endContextSeq: 2,
    publicationSequence: compartmentSequence,
    contextAckedAt: null,
    bustRepresentedAt: null,
    memoryDurableAckAt: null,
    memoryReceiptHash: null,
    deliveredReceiptId: null,
    deliveredReceiptPublicationId: null,
    deliveredCanonicalPayloadHash: null,
    deliveredContractVersion: null,
    shardId: null,
    shardVerifiedAt: null,
    reclaimedAt: null,
  };
}

test("reclaim: none of the four conditions → not eligible", () => {
  assert.equal(isReclaimEligible(baseView(1)), false);
});

test("reclaim: all four conditions (incl. bound receipt) → eligible", () => {
  const view = withShardVerified(
    withMemoryDurableAck(
      withBustRepresented(withContextAck(baseView(1), "t1"), "t2"),
      "t3",
      "receipt-hash",
    ),
    "shard-1",
    "t4",
  );
  const full: CompartmentReleaseView = {
    ...view,
    deliveredReceiptId: "r-1",
    deliveredReceiptPublicationId: "p-1",
    deliveredCanonicalPayloadHash: "h-1",
    deliveredContractVersion: "0.3.0",
  };
  assert.equal(isReclaimEligible(full), true);
});

test("reclaim: missing bound receipt identity → NOT eligible (bare hash insufficient)", () => {
  const view = withShardVerified(
    withMemoryDurableAck(withBustRepresented(withContextAck(baseView(1), "t1"), "t2"), "t3", "h"),
    "shard-1",
    "t4",
  );
  assert.equal(isReclaimEligible(view), false, "no delivered receipt binding → keep hot rows");
  const partial: CompartmentReleaseView = {
    ...view,
    deliveredReceiptId: "r-1",
    deliveredReceiptPublicationId: "p-1",
    deliveredCanonicalPayloadHash: null,
    deliveredContractVersion: "0.3.0",
  };
  assert.equal(isReclaimEligible(partial), false, "missing canonical payload hash → not eligible");
});

test("reclaim: already reclaimed → not eligible again", () => {
  const full: CompartmentReleaseView = {
    ...baseView(1),
    contextAckedAt: "t1",
    bustRepresentedAt: "t2",
    memoryDurableAckAt: "t3",
    deliveredReceiptId: "r",
    deliveredReceiptPublicationId: "p",
    deliveredCanonicalPayloadHash: "h",
    deliveredContractVersion: "v",
    shardId: "s",
    shardVerifiedAt: "t4",
    reclaimedAt: "t5",
  };
  assert.equal(isReclaimEligible(full), false);
});

test("reclaim: eligibleForReclaim filters + sorts by compartmentSequence", () => {
  const eligible = eligibleForReclaim([
    withContextAck(baseView(5), "t"),
    withShardVerified(
      withMemoryDurableAck(withBustRepresented(withContextAck(baseView(2), "t"), "t"), "t", "h"),
      "s",
      "t",
    ),
  ]);
  // 只有第二个满足四条件（第一个缺 bust/memory/shard）。
  assert.equal(eligible.length, 0, "first view lacks conditions; second lacks receipt binding");
  const full1: CompartmentReleaseView = {
    ...baseView(2),
    contextAckedAt: "t",
    bustRepresentedAt: "t",
    memoryDurableAckAt: "t",
    deliveredReceiptId: "r",
    deliveredReceiptPublicationId: "p",
    deliveredCanonicalPayloadHash: "h",
    deliveredContractVersion: "v",
    shardId: "s",
    shardVerifiedAt: "t",
  };
  const full2: CompartmentReleaseView = {
    ...baseView(1),
    contextAckedAt: "t",
    bustRepresentedAt: "t",
    memoryDurableAckAt: "t",
    deliveredReceiptId: "r",
    deliveredReceiptPublicationId: "p",
    deliveredCanonicalPayloadHash: "h",
    deliveredContractVersion: "v",
    shardId: "s",
    shardVerifiedAt: "t",
  };
  const selected = eligibleForReclaim([full1, full2]);
  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.compartmentSequence, 1, "sorted ascending");
  assert.equal(selected[1]?.compartmentSequence, 2);
});

test("reclaim: shard seal content is deterministic + includes contextSeq coords", () => {
  const view: CompartmentReleaseView = {
    ...baseView(1),
    contextAckedAt: "t",
  };
  const seal1 = sealShardContent("l", [view, { ...baseView(2) }], 2);
  const seal2 = sealShardContent("l", [{ ...baseView(2) }, view], 2);
  assert.equal(seal1, seal2, "deterministic regardless of input order");
  assert.ok(seal1.includes("startContextSeq"));
  assert.ok(seal1.includes("endContextSeq"));
  assert.equal(deriveShardId("l", 3), "shard-l-3");
});
