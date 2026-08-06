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

import type {
  HistorianBoundarySnapshot,
  HistorianSessionState,
  SequencedSessionEntry,
} from "../contracts/historian.js";
import type { HistorianAnalysisView } from "./historian-analysis.js";
import type { HistorianStore } from "./historian-store.js";

/**
 * R3 ContinuitySnapshot + wrapup + previous-session overlap
 * (issue #8 Phase B Feature B6).
 *
 * On rollover the OLD Session is finalized (closing → closed /
 * closed_incomplete) and a ContinuitySnapshot captures the frozen final
 * head: current situation, recent decisions, open threads, assistant
 * commitments, active user constraints, recent memory refs. The NEW Runtime
 * Session starts with a FRESH Context lineage; the snapshot is the ONLY
 * bridge — old Session entries are NEVER spliced into the new Pi Session.
 *
 * Rollover does NOT wait for wrapup: wrapup is enqueued at normal priority
 * (B2); on success the new Session consumes the accepted Snapshot; on
 * failure the new Session falls back to the latest compatible older
 * snapshot with a bounded overlap (which never re-enters Historian /
 * Evidence / Graphiti).
 *
 * Snapshot content preserves user constraints, open threads, commitments
 * and attribution — it never elevates external statements into
 * unattributed facts.
 */

export type ContinuitySnapshotField =
  | "currentSituation"
  | "recentDecisions"
  | "openThreads"
  | "assistantCommitments"
  | "activeUserConstraints"
  | "recentMemoryRefs";

export interface ContinuitySnapshot {
  continuitySnapshotId: string;
  runtimeSessionId: string;
  /** Session-local snapshot sequence (1-based). */
  snapshotSequence: number;
  /** The frozen final head (inclusive entrySeq). */
  finalHeadEntrySeq: number;
  /** Source range hash of the frozen final head. */
  sourceRangeHash: string;
  currentSituation: string;
  recentDecisions: string[];
  openThreads: string[];
  assistantCommitments: string[];
  activeUserConstraints: string[];
  recentMemoryRefs: string[];
  /** Attributed provenance: role -> entryIds (never unattributed facts). */
  attribution: Array<{ role: string; entryIds: string[] }>;
  /** True when the wrapup drained everything (closed); false when the head
   * still had unprocessed tail (closed_incomplete). */
  complete: boolean;
  createdAt: string;
}

export interface WrapupInput {
  store: HistorianStore;
  runtimeSessionId: string;
  /** The session state BEFORE the final drain (status active/closing). */
  state: HistorianSessionState;
  /** The frozen final boundary. */
  boundary: HistorianBoundarySnapshot;
  /** All eligible entries up to the frozen final head. */
  eligibleEntries: SequencedSessionEntry[];
  analysis: HistorianAnalysisView;
  nowMs?: () => number;
  /**
   * R3-P4：为 false 时只写不提交——调用方拥有事务（v13 最终 wrapup 事务把
   * session_state + continuity_snapshot + 最终 publication/outbox/assessment
   * 合并到 ONE 事务；任何一步失败整事务回滚）。缺省 true = 独立事务
   * （R3-P0/B6 行为不变）。
   */
  commit?: boolean;
}

export interface WrapupResult {
  snapshot: ContinuitySnapshot | null;
  status: "closed" | "closed_incomplete" | "nothing_to_snapshot" | "already_finalized";
}

/** Build the ContinuitySnapshot from the frozen final head (PURE). */
export function buildContinuitySnapshot(input: WrapupInput): ContinuitySnapshot {
  const { runtimeSessionId, boundary, eligibleEntries, analysis } = input;
  const snapshotSequence = input.store.nextSnapshotSequence(runtimeSessionId);
  const headEntries = eligibleEntries;
  const sourceRangeHash = createHash("sha256")
    .update(
      `${runtimeSessionId}:${boundary.observedHeadEntrySeq}:${headEntries.map((e) => e.contentHash).join(";")}`,
      "utf8",
    )
    .digest("hex");

  // Deterministic field extraction from the VERIFIED provider-visible units
  // (the SAME basis as compartments — never a separate projection).
  const userText: string[] = [];
  const decisions: string[] = [];
  const openThreads: string[] = [];
  const commitments: string[] = [];
  const constraints: string[] = [];
  // STUB: recentMemoryRefs is wired by the B7 recall-projection consumer
  // (the caller populates it before persistence). Until then it stays
  // empty — never fabricated (AGENTS.md: mocks/placeholders must be
  // flagged).
  const memoryRefs: string[] = [];
  const attribution = new Map<string, string[]>();

  for (const unit of analysis.units) {
    const entry = headEntries.find((e) => e.entrySeq === unit.entrySeq);
    if (entry === undefined) {
      continue;
    }
    const text = unit.providerVisible;
    if (text.length === 0) {
      continue;
    }
    if (unit.kind === "user_input") {
      userText.push(text);
      // A user turn IS an active constraint carrier (their request stands).
      constraints.push(text);
    }
    if (unit.kind === "assistant") {
      if (/decision|commit|will |decide|agreed/i.test(text)) {
        decisions.push(text);
      }
      if (/commit|will /i.test(text)) {
        commitments.push(text);
      }
    }
    if (/open|pending|next step|follow.?up|todo|blocked/i.test(text)) {
      openThreads.push(text);
    }
    // memoryRef mention detection (B7 recall projection targets are wired
    // here by the caller — see setRecentMemoryRefs).
    const roleForAttribution =
      unit.kind === "user_input"
        ? "user"
        : unit.kind === "tool_result"
          ? "tool_observation"
          : unit.kind === "assistant"
            ? "iris_decision"
            : "other";
    const ids = attribution.get(roleForAttribution) ?? [];
    ids.push(unit.entryId);
    attribution.set(roleForAttribution, ids);
  }

  const snapshot: ContinuitySnapshot = {
    continuitySnapshotId: `snapshot-${runtimeSessionId}-${snapshotSequence}`,
    runtimeSessionId,
    snapshotSequence,
    finalHeadEntrySeq: boundary.observedHeadEntrySeq,
    sourceRangeHash,
    currentSituation: userText.slice(-4).join("\n"),
    recentDecisions: decisions.slice(-8),
    openThreads: openThreads.slice(-8),
    assistantCommitments: commitments.slice(-8),
    activeUserConstraints: constraints.slice(-8),
    recentMemoryRefs: memoryRefs.slice(-8),
    attribution: [...attribution.entries()].map(([role, entryIds]) => ({ role, entryIds })),
    complete: false, // caller sets after the drain verdict
    createdAt: new Date((input.nowMs ?? (() => Date.now()))()).toISOString(),
  };
  return snapshot;
}

/** Finalize a Session and persist its ContinuitySnapshot (B6 wrapup). */
export function runWrapup(input: WrapupInput): WrapupResult {
  const { store, runtimeSessionId, boundary } = input;

  // F5 (iris_agent#42 AC6) idempotency guard: a Session that is already
  // closed / closed_incomplete has already run its terminal transition.
  // Duplicate wrapup requests (recovery re-enqueue, repeated wrapup after a
  // crash between the final transaction and queue cleanup) must NOT write a
  // second ContinuitySnapshot or re-run the transition.
  if (input.state.status === "closed" || input.state.status === "closed_incomplete") {
    return { snapshot: null, status: "already_finalized" };
  }

  if (input.eligibleEntries.length === 0 && (input.state.processedThroughEntrySeq ?? 0) === 0) {
    // F5 (iris_agent#42 BLOCKING-2): nothing to snapshot, but if the Session
    // is CLOSING the terminal transition must still complete — a durable
    // closing must never strand without a final state. A session whose head
    // is entirely inside the protected tail (eligibleThroughEntrySeq=0, e.g.
    // an in-flight tool arc at freeze time) has no snapshot content, but its
    // wrapup still terminates closing → closed (no snapshot written). Keeps
    // the caller's transaction semantics (commit:false writes, caller
    // commits; commit:true wraps its own transaction).
    if (input.state.status === "closing") {
      const write = (): void => {
        store.upsertSessionState({
          runtimeSessionId,
          processedThroughEntrySeq: input.state.processedThroughEntrySeq,
          status: "closed",
          observedHeadEntrySeq: boundary.observedHeadEntrySeq,
          updatedAt: new Date((input.nowMs ?? (() => Date.now()))()).toISOString(),
        });
      };
      if (input.commit === false) {
        write();
      } else {
        store.begin();
        try {
          write();
          store.commit();
        } catch (error) {
          store.rollback();
          throw error;
        }
      }
      return { snapshot: null, status: "closed" };
    }
    return { snapshot: null, status: "nothing_to_snapshot" };
  }

  const snapshot = buildContinuitySnapshot(input);

  // The drain verdict: complete when the frozen head was fully eligible
  // (the freeze drained everything through the observed head); incomplete
  // otherwise (a protected tail / in-flight seam remained at freeze time).
  const complete = boundary.eligibleThroughEntrySeq >= boundary.observedHeadEntrySeq;
  const status: WrapupResult["status"] = complete ? "closed" : "closed_incomplete";
  const finalSnapshot: ContinuitySnapshot = { ...snapshot, complete };

  // Atomic: the state transition + the snapshot persist in ONE transaction
  // (B6 review #3 — a crash between the two writes must not leave a closed
  // session without its snapshot). R3-P4：commit=false 时由调用方的事务
  // 承接（v13 最终 wrapup 事务与 B5 的 publication/outbox/assessment 合并）。
  const write = (): void => {
    store.upsertSessionState({
      runtimeSessionId,
      processedThroughEntrySeq: input.state.processedThroughEntrySeq,
      status,
      observedHeadEntrySeq: boundary.observedHeadEntrySeq,
      updatedAt: new Date((input.nowMs ?? (() => Date.now()))()).toISOString(),
    });
    store.insertContinuitySnapshot(finalSnapshot);
  };
  if (input.commit === false) {
    write();
  } else {
    store.begin();
    try {
      write();
      store.commit();
    } catch (error) {
      store.rollback();
      throw error;
    }
  }
  return { snapshot: finalSnapshot, status };
}

/**
 * Previous-session overlap for the NEW Runtime Session: the bounded tail of
 * the OLD Session's snapshot that the new Session may read — NEVER re-enters
 * Historian/Evidence/Graphiti (it is a read-only projection bridge).
 */
export interface OverlapProjection {
  runtimeSessionId: string;
  snapshotSequence: number;
  /** Bounded overlap slice (max N recent snapshot fields, oldest-first). */
  currentSituation: string;
  openThreads: string[];
  activeUserConstraints: string[];
  assistantCommitments: string[];
  bounded: boolean;
}

/**
 * Build a BOUNDED overlap projection from an accepted (or latest compatible)
 * ContinuitySnapshot. The overlap NEVER contains new-Session messages (it
 * comes only from the old Session's snapshot) and NEVER elevates external
 * statements to unattributed facts (attribution stays attached).
 */
export function buildOverlapProjection(
  snapshot: ContinuitySnapshot,
  maxFields?: number,
): OverlapProjection {
  const bound = maxFields ?? 12;
  return {
    runtimeSessionId: snapshot.runtimeSessionId,
    snapshotSequence: snapshot.snapshotSequence,
    currentSituation: snapshot.currentSituation.slice(0, 4000),
    openThreads: snapshot.openThreads.slice(0, bound),
    activeUserConstraints: snapshot.activeUserConstraints.slice(0, bound),
    assistantCommitments: snapshot.assistantCommitments.slice(0, bound),
    bounded: true,
  };
}

/** Latest compatible snapshot for a Session (fallback path). */
export function latestCompatibleSnapshot(
  store: HistorianStore,
  runtimeSessionId: string,
): ContinuitySnapshot | undefined {
  return store.listContinuitySnapshots(runtimeSessionId, 1)[0];
}
