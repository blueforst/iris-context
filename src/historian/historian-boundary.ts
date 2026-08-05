/**
 * R3 Historian 模块移植说明（R3-P0 port）：
 *
 * 本文件从已通过审查的 `agent/r2-product-parity-fix-r3-historian` 分支
 * （commit 5b94db7，R3 v13 对齐实现 B1–B8）原样移植到 main，作为 R3
 * Historian 子系统的基座（issue #8 Phase B）。代码逻辑与分支保持逐字节一致；
 * 所有针对 main 依赖集的适配点均以内联中文注释（"移植说明/R3-P0"）标注。
 * 后续 R3-P1..P4 工作项负责对齐 v13 规格的增量（ContextHistoryReadPort
 * m0-clamp 等）。
 */
import { createHash } from "node:crypto";

import type { HistorianBoundarySnapshot, SequencedSessionEntry } from "../contracts/historian.js";

/**
 * R3 Historian boundary freeze (issue #8 Phase B Feature B3).
 *
 * cheap trigger → freeze boundary snapshot.
 *
 * The freeze is a PURE computation over the Session head: it finds the
 * SAFEST eligible seam — the last entrySeq that can be semantically
 * processed WITHOUT cutting:
 *   - a tool arc (assistant toolCall … toolResult pair);
 *   - an incomplete invocation (an assistant turn still in flight);
 *   - a user message pair (user + companion) in the middle.
 *
 * The runner consumes EXACTLY this snapshot (same boundarySnapshotId) and
 * NEVER widens the range. `unprocessedFromEntrySeq` is derived
 * deterministically from the durable cursor + the snapshot.
 */

export interface BoundaryFreezeInput {
  runtimeSessionId: string;
  /** Raw sequenced entries of the CURRENT Session head (from the read port). */
  entries: SequencedSessionEntry[];
  /** The durable processed cursor (highest committed entrySeq). */
  processedThroughEntrySeq: number;
  /** Tail margin in entrySeqs (how many raw entries stay in the protected
   * tail beyond the eligible seam). Default 2. */
  tailMarginEntries?: number;
  /** Model/provider profile that produced the projection. */
  modelProviderProfile: string;
  /** Frozen at. */
  frozenAt: string;
  /** Optional deterministic token estimate for the eligible range. */
  estimateTokens?: (text: string) => number;
}

export interface BoundaryFreezeResult {
  snapshot: HistorianBoundarySnapshot;
  /** Deterministic: the first entrySeq not yet semantically processed. */
  unprocessedFromEntrySeq: number;
  /** True when there is nothing new to process (head <= cursor). */
  nothingNew: boolean;
}

/** Assistant message entry (durable tool-arc discovery). */
interface AssistantLike {
  entrySeq: number;
  toolCallIds: string[];
}

function isToolResult(entry: SequencedSessionEntry): boolean {
  const candidate = entry.entry as { message?: { role?: string; toolCallId?: string } };
  const message = candidate?.message;
  return message?.role === "toolResult";
}

/** Collect assistant entries with their toolCall ids (raw scan, B3 seam). */
function collectAssistants(entries: SequencedSessionEntry[]): AssistantLike[] {
  const out: AssistantLike[] = [];
  for (const entry of entries) {
    const candidate = entry.entry as {
      message?: {
        role?: string;
        content?: Array<{ type?: string; id?: string }>;
      };
    };
    const message = candidate?.message;
    if (message?.role !== "assistant") {
      continue;
    }
    const toolCallIds: string[] = [];
    for (const part of message.content ?? []) {
      if (part?.type === "toolCall" && typeof part.id === "string") {
        toolCallIds.push(part.id);
      }
    }
    out.push({ entrySeq: entry.entrySeq, toolCallIds });
  }
  return out;
}

/** The last toolResult entrySeq whose callId resolves to an assistant
 * toolCall at or before the candidate seam (complete-arc end). */
function lastCompleteArcEnd(entries: SequencedSessionEntry[]): number {
  const assistants = collectAssistants(entries);
  const callIdsInFlight = new Set<string>();
  for (const assistant of assistants) {
    for (const id of assistant.toolCallIds) {
      callIdsInFlight.add(id);
    }
  }
  let lastEnd = 0;
  for (const entry of entries) {
    if (!isToolResult(entry)) {
      continue;
    }
    const candidate = entry.entry as {
      message?: { toolCallId?: string };
    };
    const callId = candidate?.message?.toolCallId;
    if (callId !== undefined && callIdsInFlight.has(callId)) {
      lastEnd = entry.entrySeq;
    }
  }
  return lastEnd;
}

/**
 * Freeze the boundary. PURE (no I/O). Deterministic for the same input.
 * The seam is the min of:
 *   - the last complete tool arc end;
 *   - the head minus the tail margin (protected tail never cut);
 *   - an entry inside an ACTIVE assistant's toolCall window is never a seam.
 */
export function freezeBoundary(input: BoundaryFreezeInput): BoundaryFreezeResult {
  const tailMargin = input.tailMarginEntries ?? 2;
  const head =
    input.entries.length === 0 ? 0 : (input.entries[input.entries.length - 1]?.entrySeq ?? 0);
  const unprocessedFromEntrySeq = Math.max(1, input.processedThroughEntrySeq + 1);

  if (head <= input.processedThroughEntrySeq) {
    return {
      snapshot: emptySnapshot(input, head),
      unprocessedFromEntrySeq,
      nothingNew: true,
    };
  }

  // 1. Last complete tool arc end (never cut an arc).
  const arcEnd = lastCompleteArcEnd(input.entries);
  // 2. Protected tail margin (never cut the dynamic tail).
  const tailBoundary = Math.max(0, head - tailMargin);
  // 3. In-flight invocation seam: the seam must NOT land INSIDE an
  //    assistant turn whose toolCall window extends past the seam. Walk
  //    back: find the last assistant entrySeq whose toolCall has no
  //    toolResult at or before the candidate seam, and clamp the seam
  //    strictly before it (an incomplete invocation is never cut).
  let seam = tailBoundary;
  if (arcEnd > 0) {
    seam = Math.min(seam, arcEnd);
  }
  const assistantEntries = collectAssistants(input.entries);
  const toolResultCallIds = new Set<string>();
  for (const entry of input.entries) {
    if (isToolResult(entry)) {
      const candidate = entry.entry as { message?: { toolCallId?: string } };
      const callId = candidate?.message?.toolCallId;
      if (callId !== undefined) {
        toolResultCallIds.add(callId);
      }
    }
  }
  for (const assistant of assistantEntries) {
    if (assistant.entrySeq >= seam) {
      continue; // entirely in the protected tail — never cut
    }
    const hasUnclosedCall = assistant.toolCallIds.some((id) => !toolResultCallIds.has(id));
    if (hasUnclosedCall) {
      // This assistant's toolCall is not closed within the eligible range →
      // the seam must be strictly before it (discard the in-flight turn).
      seam = Math.min(seam, assistant.entrySeq - 1);
    }
  }

  // Ensure the seam never exceeds the head or falls below the cursor.
  seam = Math.max(input.processedThroughEntrySeq, Math.min(seam, tailBoundary));

  const eligibleThroughEntrySeq = seam;
  const protectedTailStartEntrySeq = Math.min(head, seam + 1);
  // The source range hash covers ONLY the unprocessed window
  // [unprocessedFromEntrySeq .. eligibleThroughEntrySeq] — the SAME window
  // the runner re-reads and re-verifies on its next run. Including already-
  // processed entries below unprocessedFromEntrySeq would make the frozen
  // hash diverge from the runner's re-read on every cycle after the first
  // commit (the runner starts from the durable cursor), permanently
  // stalling the Historian (issue #8 R3 B3 review blocker).
  const eligibleEntries = input.entries.filter(
    (e) => e.entrySeq >= unprocessedFromEntrySeq && e.entrySeq <= eligibleThroughEntrySeq,
  );
  const sourceRangeHash = rangeHash(
    input.runtimeSessionId,
    unprocessedFromEntrySeq,
    eligibleThroughEntrySeq,
    eligibleEntries,
  );
  const rawText = eligibleEntries.map((e) => JSON.stringify(e.entry)).join("");
  const trueRawEligibleTokens =
    input.estimateTokens === undefined ? rawText.length : input.estimateTokens(rawText);
  const narratableEligibleTokens = trueRawEligibleTokens;

  return {
    snapshot: {
      boundarySnapshotId: `bs-${input.runtimeSessionId}-${head}`,
      runtimeSessionId: input.runtimeSessionId,
      observedHeadEntrySeq: head,
      eligibleThroughEntrySeq,
      protectedTailStartEntrySeq,
      trueRawEligibleTokens,
      narratableEligibleTokens,
      sourceRangeHash,
      modelProviderProfile: input.modelProviderProfile,
      frozenAt: input.frozenAt,
    },
    unprocessedFromEntrySeq,
    nothingNew: false,
  };
}

function emptySnapshot(input: BoundaryFreezeInput, head: number): HistorianBoundarySnapshot {
  return {
    boundarySnapshotId: `bs-${input.runtimeSessionId}-${head}-empty`,
    runtimeSessionId: input.runtimeSessionId,
    observedHeadEntrySeq: head,
    eligibleThroughEntrySeq: input.processedThroughEntrySeq,
    protectedTailStartEntrySeq: Math.max(1, head + 1),
    trueRawEligibleTokens: 0,
    narratableEligibleTokens: 0,
    sourceRangeHash: rangeHash(input.runtimeSessionId, 0, 0, []),
    modelProviderProfile: input.modelProviderProfile,
    frozenAt: input.frozenAt,
  };
}

/** Deterministic sha256 over the range identity + entry content. */
export function rangeHash(
  runtimeSessionId: string,
  startEntrySeq: number,
  endEntrySeq: number,
  entries: Array<{ entryId: string; entrySeq: number; contentHash: string }>,
): string {
  const hash = createHash("sha256");
  hash.update(runtimeSessionId);
  hash.update(`:${startEntrySeq}:${endEntrySeq}:`);
  for (const entry of entries) {
    hash.update(`${entry.entrySeq}:${entry.entryId}:${entry.contentHash};`);
  }
  return hash.digest("hex");
}
