/**
 * R3-P1：historian-boundary freeze 的纯单元测试（B3 语义 + m0-clamp）。
 *
 * 覆盖：
 *  - 纯 raw 语义保持（R3-P0）：无 lineage 边界时 eligibleThrough = rawSafeSeam；
 *    in-flight toolCall 窗内的 seam 不被切（raw 语义优先）；
 *  - R3-P1 m0-clamp：lineage representedThroughEntrySeq 落后于 raw seam →
 *    eligibleThrough = lineage（收紧）；领先 → 不收紧（仍为 raw seam）；null →
 *    不 clamp；
 *  - protectedTailStart 恒为 rawSafeSeam（不被 lineage 边界挤压）；
 *  - nothingNew（head <= cursor）路径不受 clamp 影响；
 *  - 确定性：同输入 → 同 snapshot（含 sourceRangeHash / token 估计）。
 */
import test from "node:test";

import assert from "node:assert/strict";

import type { SequencedSessionEntry } from "../src/contracts/historian.js";
import { freezeBoundary, type BoundaryFreezeInput } from "../src/historian/historian-boundary.js";

const SESSION = "iris-runtime-2026-08-01-1";

/** 纯 user 消息条目（无 tool arc / assistant 干扰，seam 只看 head）。 */
function userEntry(entrySeq: number): SequencedSessionEntry {
  return {
    runtimeSessionId: SESSION,
    entrySeq,
    entryId: `u-${entrySeq}`,
    entry: { message: { role: "user", content: `user ${entrySeq}`, timestamp: entrySeq } },
    contentHash: `h-${entrySeq}`,
  };
}

/** assistant 条目（可携带 toolCall ids）。 */
function assistantEntry(entrySeq: number, toolCallIds: string[]): SequencedSessionEntry {
  return {
    runtimeSessionId: SESSION,
    entrySeq,
    entryId: `a-${entrySeq}`,
    entry: {
      message: {
        role: "assistant",
        content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "tool" })),
        timestamp: entrySeq,
      },
    },
    contentHash: `h-${entrySeq}`,
  };
}

/** toolResult 条目。 */
function toolResultEntry(entrySeq: number, toolCallId: string): SequencedSessionEntry {
  return {
    runtimeSessionId: SESSION,
    entrySeq,
    entryId: `t-${entrySeq}`,
    entry: {
      message: { role: "toolResult", toolCallId, content: "ok", timestamp: entrySeq },
    },
    contentHash: `h-${entrySeq}`,
  };
}

function freezeInput(
  entries: SequencedSessionEntry[],
  lineageEntrySeq: number | null | undefined,
  processedThroughEntrySeq = 0,
): BoundaryFreezeInput {
  return {
    rawSeamInput: {
      runtimeSessionId: SESSION,
      entries,
      processedThroughEntrySeq,
      tailMarginEntries: 0,
      modelProviderProfile: "mock-iris-provider-v1",
      frozenAt: "2026-08-01T00:00:00.000Z",
    },
    ...(lineageEntrySeq === undefined
      ? {}
      : { lineageBoundary: { representedThroughEntrySeq: lineageEntrySeq } }),
  };
}

/** 100 条纯 user 条目：rawSafeSeam = head = 100。 */
function hundredUserEntries(): SequencedSessionEntry[] {
  return Array.from({ length: 100 }, (_, index) => userEntry(index + 1));
}

test("R3-P1 freeze: lineage null → no clamp (eligibleThrough = rawSafeSeam)", () => {
  const result = freezeBoundary(freezeInput(hundredUserEntries(), null));
  assert.equal(result.nothingNew, false);
  assert.equal(result.snapshot.eligibleThroughEntrySeq, 100, "null lineage never clamps");
  assert.equal(result.snapshot.protectedTailStartEntrySeq, 100);
  assert.equal(result.snapshot.observedHeadEntrySeq, 100);
});

test("R3-P1 freeze: lineage behind raw seam → eligibleThrough clamped to lineage, protectedTail stays raw", () => {
  // rawSafeSeam = 100，lineage = 60 → eligibleThrough = 60（只有已进入 m0/m1 的
  // compartment 可被 raw 替换）；protectedTailStart 保持 rawSafeSeam = 100。
  const result = freezeBoundary(freezeInput(hundredUserEntries(), 60));
  assert.equal(result.snapshot.eligibleThroughEntrySeq, 60);
  assert.equal(result.snapshot.protectedTailStartEntrySeq, 100);
  // sourceRangeHash 覆盖 clamp 后的窗口 [1..60]。
  assert.equal(result.snapshot.observedHeadEntrySeq, 100);
  const unclamped = freezeBoundary(freezeInput(hundredUserEntries(), null));
  assert.notEqual(result.snapshot.sourceRangeHash, unclamped.snapshot.sourceRangeHash);
});

test("R3-P1 freeze: lineage ahead of raw seam → no clamp (eligibleThrough = rawSafeSeam)", () => {
  const result = freezeBoundary(freezeInput(hundredUserEntries(), 150));
  assert.equal(result.snapshot.eligibleThroughEntrySeq, 100, "lineage beyond seam never widens");
  assert.equal(result.snapshot.protectedTailStartEntrySeq, 100);
});

test("R3-P1 freeze: raw in-flight seam semantics are preserved under the clamp", () => {
  // entries：user(1..3) + assistant(4, toolCall tc-1) + toolResult(5, tc-2)。
  // tc-1 在 eligible 范围内未闭合 → raw seam 收紧到 3（strictly before the
  // in-flight turn）；lineage = 60 落后？不——raw seam(3) 已经小于 lineage(60)，
  // clamp 取 min(3, 60) = 3。raw 语义优先，lineage 永不 widening。
  const entries = [
    userEntry(1),
    userEntry(2),
    userEntry(3),
    assistantEntry(4, ["tc-1"]),
    toolResultEntry(5, "tc-2"),
  ];
  const result = freezeBoundary(freezeInput(entries, 60));
  assert.equal(result.snapshot.eligibleThroughEntrySeq, 3, "in-flight seam dominates");
  assert.equal(result.snapshot.protectedTailStartEntrySeq, 4);
});

test("R3-P1 freeze: nothingNew path is preserved and clamp is irrelevant there", () => {
  // head = 3 <= processedThrough = 3 → nothingNew，snapshot 为空快照。
  const result = freezeBoundary(freezeInput([userEntry(1), userEntry(2), userEntry(3)], 60, 3));
  assert.equal(result.nothingNew, true);
  assert.equal(result.snapshot.eligibleThroughEntrySeq, 3, "empty snapshot uses the cursor");
  assert.equal(result.unprocessedFromEntrySeq, 4);
});

test("R3-P1 freeze: deterministic for the same input (clamped range hash is stable)", () => {
  const first = freezeBoundary(freezeInput(hundredUserEntries(), 60));
  const second = freezeBoundary(freezeInput(hundredUserEntries(), 60));
  assert.deepEqual(first.snapshot, second.snapshot);
  // clamp 后的 token 估计只覆盖 eligible 窗口 [1..60]。
  assert.equal(first.snapshot.trueRawEligibleTokens > 0, true);
});

test("R3-P1 freeze: eligible entries window honors the clamp (unprocessedFrom..eligibleThrough)", () => {
  // 带 processedThrough = 40：unprocessedFrom = 41；lineage = 60 → 窗口 [41..60]，
  // 排除已处理前缀与 clamp 之后的部分。
  const result = freezeBoundary(freezeInput(hundredUserEntries(), 60, 40));
  assert.equal(result.snapshot.eligibleThroughEntrySeq, 60);
  assert.equal(result.unprocessedFromEntrySeq, 41);
  assert.equal(result.snapshot.trueRawEligibleTokens > 0, true);
});
