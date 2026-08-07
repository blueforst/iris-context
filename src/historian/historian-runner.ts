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
import type {
  HistorianBoundarySnapshot,
  HistorianSessionState,
  SequencedSessionEntry,
} from "../contracts/historian.js";
import type { ContextHistoryReadPort } from "../context/history-read-port.js";
import type { ContextMessageUnit } from "../contracts/context-units.js";
import type { HistorianStore } from "./historian-store.js";
import {
  buildAnalysisView,
  validateRange,
  type HistorianAnalysisView,
  type ValidationOutcome,
} from "./historian-analysis.js";

/**
 * iris_agent#66: adapt a committed Context semantic unit to the runner's
 * internal SequencedSessionEntry shape. The payload IS the canonical
 * AgentMessage (role/content/toolCall), so the existing pure freeze/
 * analysis functions keep working — but the SOURCE is now Context-owned
 * committed units, never Pi Session transcript. The session id survives
 * only as opaque attribution; semantic identity/order come from contextSeq
 * (entrySeq is the narrow archive mapping).
 */
export function contextUnitToSequencedEntry(
  runtimeSessionId: string,
  unit: ContextMessageUnit,
): SequencedSessionEntry {
  return {
    runtimeSessionId,
    entrySeq: unit.entrySeq ?? 0,
    entryId: unit.unitId,
    entry: { type: "message", message: unit.payload },
    contentHash: unit.contentHash,
  };
}

/**
 * R3 Historian runner (issue #8 Phase B Feature B3).
 *
 *   cheap trigger → freeze boundary snapshot → read finite eligible range →
 *   build HistorianAnalysisView → provisional classification → pure
 *   validation → discard unsafe suffix → commit safe prefix
 *
 * Guarantees:
 *  - the runner consumes EXACTLY the frozen snapshot (same id) and NEVER
 *    widens the range beyond eligibleThroughEntrySeq;
 *  - source Session, range endpoints, entry IDs, hashes and cursor are
 *    re-verified BEFORE the commit (validateRange);
 *  - a failed validation NEVER advances the cursor;
 *  - protected tail, tool arcs and incomplete invocations are never cut
 *    (unsafe suffix discarded);
 *  - `unprocessedFromEntrySeq` is deterministic from the durable cursor.
 *
 * This feature commits ONLY the Session-local cursor advancement (the safe
 * prefix). Compartments/Segments/EvidenceSets + Publication + outbox are
 * committed in the SAME transaction by B5 (the commit hook is injected so
 * B3 stays a pure, verifiable seam and B5 atomically extends it).
 */

export interface RunnerCommitHook {
  /** Called INSIDE the transaction with the safe prefix; must throw on
   * failure so the whole transaction rolls back (cursor never advances). */
  commitSafePrefix(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
    safePrefix: SequencedSessionEntry[];
    analysis: HistorianAnalysisView;
    outcome: Extract<ValidationOutcome, { ok: true }>;
    /** The durable cursor BEFORE this commit (B5 chain metadata). */
    previousProcessedThroughEntrySeq: number;
  }): void;
}

export interface HistorianRunnerOptions {
  store: HistorianStore;
  /** iris_agent#66: the Context-owned history read/claim port — the ONLY
   * normal semantic input (committed Context units, contextSeq order). Pi
   * Session access is not wired here at all; it lives behind the explicitly
   * separated recovery/audit interface. */
  historyPort: ContextHistoryReadPort;
  /** Optional hook for the atomic publication transaction (B5). */
  commitHook?: RunnerCommitHook;
  pageSize?: number;
}

export interface RunnerResult {
  /** True when a safe prefix was committed (cursor advanced). */
  committed: boolean;
  commitThroughEntrySeq: number;
  unprocessedFromEntrySeq: number;
  discardedFromEntrySeq: number | null;
  status: "committed" | "nothing_new" | "validation_failed";
  errorCode?: string;
  detail?: string;
}

/** Deterministic first-unprocessed entrySeq from the durable cursor. */
export function unprocessedFromEntrySeq(state: HistorianSessionState | undefined): number {
  return Math.max(1, (state?.processedThroughEntrySeq ?? 0) + 1);
}

export class HistorianRunner {
  private readonly store: HistorianStore;
  private readonly historyPort: ContextHistoryReadPort;
  private readonly commitHook: RunnerCommitHook | undefined;
  private readonly pageSize: number;

  constructor(options: HistorianRunnerOptions) {
    this.store = options.store;
    this.historyPort = options.historyPort;
    this.commitHook = options.commitHook;
    this.pageSize = options.pageSize ?? 256;
  }

  /**
   * Run one job: consume the frozen snapshot, read the finite range, build
   * the analysis view, PURE-validate, discard the unsafe suffix, commit the
   * safe prefix (cursor + optional B5 hook) atomically. Never throws on
   * validation failure; throws only on real storage errors (the caller
   * requeues with retry).
   */
  async run(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
  }): Promise<RunnerResult> {
    const { runtimeSessionId, boundary } = input;
    const state = this.store.getSessionState(runtimeSessionId);

    // The durable cursor is the authoritative processed watermark; the
    // snapshot's range starts strictly after it (unprocessedFromEntrySeq).
    const fromEntrySeq = unprocessedFromEntrySeq(state);
    if (boundary.eligibleThroughEntrySeq < fromEntrySeq) {
      return {
        committed: false,
        commitThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
        unprocessedFromEntrySeq: fromEntrySeq,
        discardedFromEntrySeq: null,
        status: "nothing_new",
      };
    }

    // Read the FINITE eligible range (capped by the FROZEN ceiling). The
    // read happens BEFORE the transaction; the transaction itself is a
    // synchronous, atomic segment (BEGIN → writes → COMMIT).
    const eligibleEntries = await this.readRange(
      runtimeSessionId,
      fromEntrySeq - 1,
      boundary.eligibleThroughEntrySeq,
    );
    if (eligibleEntries.length === 0) {
      return {
        committed: false,
        commitThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
        unprocessedFromEntrySeq: fromEntrySeq,
        discardedFromEntrySeq: null,
        status: "nothing_new",
      };
    }

    // Build the analysis view + pure validation.
    const analysis = buildAnalysisView({
      runtimeSessionId,
      boundary,
      eligibleEntries,
    });
    const outcome = validateRange({
      runtimeSessionId,
      boundary,
      eligibleEntries,
      // iris_agent#66: the range-hash anchor is the durable cursor + 1 (the
      // freeze used the same anchor) — NOT the first present entry (claim
      // windows can start after derived-only unit gaps).
      unprocessedFromEntrySeq: fromEntrySeq,
    });
    if (!outcome.ok) {
      return {
        committed: false,
        commitThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
        unprocessedFromEntrySeq: fromEntrySeq,
        discardedFromEntrySeq: null,
        status: "validation_failed",
        errorCode: outcome.errorCode,
        detail: outcome.detail,
      };
    }

    // Commit the safe prefix INSIDE one transaction: cursor + (B5) hook.
    const safePrefix = eligibleEntries.filter((e) => e.entrySeq <= outcome.commitThroughEntrySeq);
    this.store.begin();
    try {
      const nextState: HistorianSessionState = {
        runtimeSessionId,
        processedThroughEntrySeq: outcome.commitThroughEntrySeq,
        status: state?.status ?? "active",
        ...(state?.observedHeadEntrySeq === undefined
          ? {}
          : { observedHeadEntrySeq: state.observedHeadEntrySeq }),
        updatedAt: new Date(this.store.now()).toISOString(),
      };
      this.store.upsertSessionState(nextState);
      this.commitHook?.commitSafePrefix({
        runtimeSessionId,
        boundary,
        safePrefix,
        analysis,
        outcome,
        previousProcessedThroughEntrySeq: state?.processedThroughEntrySeq ?? 0,
      });
      this.store.commit();
    } catch (error) {
      this.store.rollback();
      throw error; // storage error → caller requeues; cursor never advanced
    }

    return {
      committed: true,
      commitThroughEntrySeq: outcome.commitThroughEntrySeq,
      unprocessedFromEntrySeq: outcome.commitThroughEntrySeq + 1,
      discardedFromEntrySeq: outcome.discardedFromEntrySeq,
      status: "committed",
    };
  }

  private async readRange(
    runtimeSessionId: string,
    afterEntrySeqExclusive: number,
    throughEntrySeqInclusive: number,
  ): Promise<SequencedSessionEntry[]> {
    // iris_agent#66: the normal semantic input is committed Context units
    // claimed through the Context-owned history port (contextSeq order,
    // immutable, lineage-bound). Session ids/ranges survive only as opaque
    // attribution; no Session transcript is scanned here.
    const from = afterEntrySeqExclusive + 1;
    const units = this.historyPort.claimUnitsForHistorian(
      runtimeSessionId,
      from,
      throughEntrySeqInclusive,
    );
    const out: SequencedSessionEntry[] = [];
    for (const unit of units) {
      if (unit.entrySeq === undefined) {
        // Derived-only units (no narrow archive mapping) carry no entrySeq;
        // they are not part of the Session-scoped safe-prefix space. The
        // semantic units themselves were already committed by Context ingest.
        continue;
      }
      if (unit.entrySeq > throughEntrySeqInclusive) {
        return out; // frozen ceiling — never widen
      }
      out.push(contextUnitToSequencedEntry(runtimeSessionId, unit));
    }
    return out;
  }
}
