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
import type { ContextHistoryReadPort } from "../context/history-read-port.js";
import type { HistorianStore } from "./historian-store.js";
import type { RunnerCommitHook } from "./historian-runner.js";
import type { HistorianAnalysisView } from "./historian-analysis.js";
import type { ValidationOutcome } from "./historian-analysis.js";
import { buildCompartment } from "./historian-compartment.js";
import type { HistorianUnitView } from "./anti-echo.js";
import {
  deriveMemoryAssessments,
  type InvocationMemoryRecallProjection,
} from "./historian-assessment.js";

/**
 * R3 Historian publication + authoritative outbox (issue #8 Phase B Feature
 * B5).
 *
 * ONE atomic historian.db transaction commits:
 *   safe Compartments + Segments + EvidenceSets + AttributionManifests +
 *   (B6 ContinuitySnapshot when closing) + (B7 MemoryAssessmentDeltas) +
 *   the Session-local processed cursor + HistorianPublication +
 *   the authoritative publication_outbox row.
 *
 * Invariants:
 *  - publicationSequence is allocated as MAX+1 ONLY inside the final commit
 *    transaction — never pre-allocated before model calls;
 *  - deterministic publication ID, processing key and output hash;
 *  - previous publication / session cursor chain;
 *  - outbox state machine pending → delivering → delivered / retry_wait /
 *    quarantined; claim lease expiry recovery; never deleted or marked
 *    delivered before the Router ACK;
 *  - this IS the only durable publication outbox (no second Memory Client
 *    durable outbox);
 *  - model / parse / repair / source-validation / transaction failure →
 *    cursor does not advance, no Publication, no outbox row.
 *
 * The service is wired as the B3 runner's commit hook: it runs INSIDE the
 * runner's BEGIN..COMMIT, so a throw rolls the whole transaction back.
 */

export type OutboxState = "pending" | "delivering" | "retry_wait" | "delivered" | "quarantined";

export interface PublicationRecord {
  publicationSequence: number;
  publicationId: string;
  runtimeSessionId: string;
  processingKey: string;
  outputHash: string;
  compartmentIds: string[];
  segmentIds: string[];
  evidenceSetIds: string[];
  assessmentDeltaIds: string[];
  continuitySnapshotId: string | null;
  previousPublicationSequence: number | null;
  previousSessionProcessedThroughEntrySeq: number;
  state: OutboxState;
  attemptCount: number;
  claimLeasedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxRow {
  outboxSequence: number;
  publicationId: string;
  runtimeSessionId: string;
  payloadHash: string;
  state: OutboxState;
  attemptCount: number;
  lastErrorCode: string | null;
  claimLeasedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationServiceOptions {
  store: HistorianStore;
  /**
   * R3 (anti-echo)：Context lineage 窄读取端口。提供时,commitSafePrefix
   * 会把 Session-safe-prefix 的 entrySeq 范围映射到 Context 单元视图并
   * 传入 buildCompartment → EvidenceSet 携带 evidenceBasis/derivedOnly。
   * 缺省 = 旧行为(无 anti-echo 分类,向后兼容)。
   */
  historyPort?: ContextHistoryReadPort;
  nowMs?: () => number;
  /** Router claim lease TTL (ms). Default 60s. */
  claimLeaseMs?: number;
  /**
   * Recall projections for the invocation(s) covered by this publication
   * (B7). When provided, MemoryAssessmentDeltas are derived from THIS
   * publication's new Evidence and committed in the SAME transaction.
   */
  recallProjections?: InvocationMemoryRecallProjection[];
}

/** The commit hook the B3 runner invokes INSIDE its transaction. */
export function createPublicationCommitHook(options: PublicationServiceOptions): RunnerCommitHook {
  const service = new PublicationService(options);
  return {
    commitSafePrefix: (input) => {
      service.commitSafePrefix(input);
    },
  };
}

export class PublicationService {
  private readonly store: HistorianStore;
  private readonly nowMs: () => number;
  private readonly claimLeaseMs: number;
  private readonly recallProjections: InvocationMemoryRecallProjection[];
  private readonly historyPort: ContextHistoryReadPort | undefined;

  constructor(options: PublicationServiceOptions) {
    this.store = options.store;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.recallProjections = options.recallProjections ?? [];
    this.historyPort = options.historyPort;
  }

  /**
   * Runs INSIDE the runner's transaction. Builds the compartment from the
   * verified safe prefix, persists compartments/segments/evidence/manifest,
   * allocates the NEXT publicationSequence (MAX+1 — never pre-allocated),
   * inserts the HistorianPublication row and the authoritative outbox row.
   * Throws on failure → the whole transaction rolls back (cursor never
   * advances, no Publication, no outbox row).
   */
  commitSafePrefix(input: {
    runtimeSessionId: string;
    boundary: HistorianBoundarySnapshot;
    safePrefix: SequencedSessionEntry[];
    analysis: HistorianAnalysisView;
    outcome: Extract<ValidationOutcome, { ok: true }>;
    /** The durable cursor BEFORE this commit (chain metadata). */
    previousProcessedThroughEntrySeq: number;
  }): void {
    const { runtimeSessionId, boundary, safePrefix, analysis, outcome } = input;

    // Build the immutable compartment from the VERIFIED safe prefix.
    const nextSequence = this.store.maxCompartmentSequence(runtimeSessionId) + 1;

    // R3 (anti-echo):把 Session-safe-prefix 的 entrySeq 范围映射到 Context
    // 单元窄视图,使 EvidenceSet 携带 evidenceBasis/derivedOnly(derived-only
    // 内容不产生新 Evidence)。historyPort 未接线 → unitViews 缺省,保持旧
    // 行为(向后兼容)。
    let unitViews: HistorianUnitView[] | undefined;
    if (this.historyPort !== undefined && safePrefix.length > 0) {
      const first = safePrefix[0];
      const last = safePrefix[safePrefix.length - 1];
      if (first !== undefined && last !== undefined) {
        unitViews = this.historyPort.listUnitsForHistorianByEntrySeq(
          runtimeSessionId,
          first.entrySeq,
          last.entrySeq,
        );
      }
    }
    const built = buildCompartment({
      runtimeSessionId,
      compartmentSequence: nextSequence,
      boundary,
      eligibleEntries: safePrefix,
      analysis,
      commitThroughEntrySeq: outcome.commitThroughEntrySeq,
      ...(unitViews !== undefined ? { unitViews } : {}),
    });
    if (built === null) {
      // No eligible entries in the safe prefix — nothing to publish. This is
      // NOT a failure (nothing new); the runner still advances the cursor.
      return;
    }

    this.store.insertCompartment(built.compartment);
    this.store.insertSegments(built.segments);
    this.store.insertEvidenceSet(built.evidence);
    this.store.insertAttributionManifest(built.attributionManifest);

    // Deterministic publication identity + processing key + output hash.
    // The publicationSequence is allocated ONCE here (MAX+1 in-transaction);
    // the same value is used for the assessment deltas so the chain stays
    // strictly increasing with no gaps.
    const publicationSequence = this.nextPublicationSequence();
    const publicationId = `publication-${runtimeSessionId}-${publicationSequence}`;

    // B7: MemoryAssessmentDeltas derived from THIS publication's new raw
    // Evidence (never old evidence; only recalled targets; deduplicated).
    const assessmentDeltas =
      this.recallProjections.length === 0
        ? []
        : deriveMemoryAssessments({
            runtimeSessionId,
            publicationSequence,
            newEvidenceSets: [built.evidence],
            recallProjections: this.recallProjections,
            nowMs: this.nowMs,
          });
    for (const delta of assessmentDeltas) {
      this.store.insertAssessmentDelta(delta);
    }

    const processingKey = `${runtimeSessionId}:${built.compartment.startEntrySeq}:${built.compartment.endEntrySeq}:${built.compartment.sourceRangeHash}`;
    const outputHash = createHash("sha256")
      .update(
        `${processingKey}:${built.compartment.content}:${built.evidence.entries.map((e) => e.entryId).join(",")}`,
        "utf8",
      )
      .digest("hex");

    const now = new Date(this.nowMs()).toISOString();

    const publication: PublicationRecord = {
      publicationSequence,
      publicationId,
      runtimeSessionId,
      processingKey,
      outputHash,
      compartmentIds: [built.compartment.compartmentId],
      segmentIds: built.segments.map((segment) => segment.segmentId),
      evidenceSetIds: [built.evidence.evidenceSetId],
      assessmentDeltaIds: assessmentDeltas.map((delta) => delta.assessmentId),
      continuitySnapshotId: null,
      previousPublicationSequence: this.previousPublicationSequence(runtimeSessionId),
      // The cursor BEFORE this commit (the runner passed it from the
      // pre-transaction state — never the already-upserted value).
      previousSessionProcessedThroughEntrySeq: input.previousProcessedThroughEntrySeq,
      state: "pending",
      attemptCount: 0,
      claimLeasedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertPublication(publication);

    this.store.insertOutboxRow({
      publicationId,
      runtimeSessionId,
      payloadHash: outputHash,
      state: "pending",
      attemptCount: 0,
      lastErrorCode: null,
      claimLeasedUntil: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** publicationSequence = MAX(publication_sequence)+1 (in-transaction). */
  private nextPublicationSequence(): number {
    const row = this.store
      .raw()
      .prepare("SELECT MAX(publication_sequence) AS max_seq FROM publications")
      .get() as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  /** The previous publication sequence for the Session (chain). */
  private previousPublicationSequence(runtimeSessionId: string): number | null {
    const row = this.store
      .raw()
      .prepare(
        "SELECT MAX(publication_sequence) AS max_seq FROM publications WHERE runtime_session_id = ?",
      )
      .get(runtimeSessionId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? null;
  }

  /**
   * Claim a batch of undelivered outbox rows (state pending/retry_wait with
   * an expired lease, or delivering with an EXPIRED lease = crashed claim).
   * Leases make delivery crash-recoverable: a claim that dies mid-delivery
   * is re-claimed after its lease expires.
   */
  claimBatch(input: { batchSize: number }): OutboxRow[] {
    const now = this.nowMs();
    const rows = this.store
      .raw()
      .prepare(
        "SELECT outbox_sequence, publication_id, runtime_session_id, payload_hash, state, " +
          "attempt_count, last_error_code, claim_leased_until, created_at, updated_at " +
          "FROM publication_outbox " +
          "WHERE state IN ('pending','retry_wait','delivering') AND " +
          "(claim_leased_until IS NULL OR claim_leased_until < ?) " +
          "ORDER BY outbox_sequence ASC LIMIT ?",
      )
      .all(nowIso(now), input.batchSize) as unknown as Array<{
      outbox_sequence: number;
      publication_id: string;
      runtime_session_id: string;
      payload_hash: string;
      state: OutboxState;
      attempt_count: number;
      last_error_code: string | null;
      claim_leased_until: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const leasedUntil = new Date(now + this.claimLeaseMs).toISOString();
    const update = this.store
      .raw()
      .prepare(
        "UPDATE publication_outbox SET state = 'delivering', claim_leased_until = ?, updated_at = ? WHERE outbox_sequence = ?",
      );
    for (const row of rows) {
      update.run(leasedUntil, new Date(now).toISOString(), row.outbox_sequence);
    }
    return rows.map((row) => ({
      outboxSequence: row.outbox_sequence,
      publicationId: row.publication_id,
      runtimeSessionId: row.runtime_session_id,
      payloadHash: row.payload_hash,
      state: "delivering",
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      claimLeasedUntil: leasedUntil,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Mark a claimed publication delivered (Router ACK — the ONLY path to
   * delivered; never delete, never pre-ack). The receipt hash is persisted
   * for the delivery audit trail. */
  markDelivered(input: { publicationId: string; receiptHash: string }): void {
    const now = new Date(this.nowMs()).toISOString();
    this.store
      .raw()
      .prepare(
        "UPDATE publication_outbox SET state = 'delivered', claim_leased_until = NULL, updated_at = ? WHERE publication_id = ?",
      )
      .run(now, input.publicationId);
    this.store
      .raw()
      .prepare(
        "UPDATE publications SET state = 'delivered', delivered_at = ?, delivered_receipt_hash = ?, updated_at = ? WHERE publication_id = ?",
      )
      .run(now, input.receiptHash, now, input.publicationId);
  }

  /**
   * Mark a claimed publication failed (retry_wait up to attempts, then
   * quarantined).
   *
   * R3-P3 修复（R3-P0 oracle 审查标记）：retry_wait 必须携带未来退避 lease
   * （now + exponential backoff(attempt)），而不是 NULL。若为 NULL，
   * claimBatch 的 `claim_leased_until IS NULL` 分支会立即重新认领该行，
   * 产生无退避热循环。quarantined 不可认领（state 不在 claimBatch 候选），
   * lease 置 NULL 以便审计读取干净。
   */
  markFailed(input: { publicationId: string; errorCode: string; maxAttempts?: number }): void {
    const nowMs = this.nowMs();
    const now = new Date(nowMs).toISOString();
    const row = this.store
      .raw()
      .prepare("SELECT attempt_count FROM publication_outbox WHERE publication_id = ?")
      .get(input.publicationId) as { attempt_count: number } | undefined;
    const attempts = (row?.attempt_count ?? 0) + 1;
    const maxAttempts = input.maxAttempts ?? 8;
    const nextState = attempts >= maxAttempts ? "quarantined" : "retry_wait";
    // retry_wait → 未来退避 lease；quarantined → NULL（不可认领）。
    const claimLeasedUntil =
      nextState === "retry_wait"
        ? new Date(nowMs + this.retryBackoffMs(attempts)).toISOString()
        : null;
    this.store
      .raw()
      .prepare(
        "UPDATE publication_outbox SET state = ?, attempt_count = ?, last_error_code = ?, claim_leased_until = ?, updated_at = ? WHERE publication_id = ?",
      )
      .run(nextState, attempts, input.errorCode, claimLeasedUntil, now, input.publicationId);
    this.store
      .raw()
      .prepare(
        "UPDATE publications SET state = ?, attempt_count = ?, updated_at = ? WHERE publication_id = ?",
      )
      .run(nextState, attempts, now, input.publicationId);
  }

  /** 指数退避（毫秒）：attempt 1 → 1s，attempt 2 → 2s … 上限 5 分钟。 */
  private retryBackoffMs(attempt: number): number {
    return Math.min(1_000 * 2 ** (attempt - 1), 5 * 60_000);
  }
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}
