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
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "../db/migrate.js";
import type { HistorianBoundarySnapshot, HistorianSessionState } from "../contracts/historian.js";
import type {
  AttributionManifest,
  EvidenceSet,
  HistoricalCompartment,
  HistorianSegment,
} from "./historian-compartment.js";
import type { OutboxRow, PublicationRecord } from "./historian-publication.js";
import type { ContinuitySnapshot } from "./historian-continuity.js";
import type { MemoryAssessmentDelta } from "./historian-assessment.js";
import type { CompartmentReleaseView } from "./hot-row-reclaim.js";

/**
 * R3 HistorianStore — the Historian's OWN durable store (historian.db,
 * issue #8 Phase B Feature B1).
 *
 * Boundaries honored here:
 *  - the Historian NEVER reads the Context repository (m0/m1/LKG) and NEVER
 *    writes the Pi Session;
 *  - every durable write the Historian performs is committed in ONE
 *    transaction together with the publication + outbox row (B5);
 *  - migrations are forward-only, checksum-verified, idempotent, and a
 *    NEWER schema (an applied version absent from the migration dir) fails
 *    closed at open.
 *
 * The store exposes the DTO layer only; the semantic pipeline (trigger →
 * freeze → read → validate → commit) lives in the historian runtime modules
 * (B2-B7).
 */

export interface HistorianStoreOptions {
  /** historian.db path. */
  databasePath: string;
  /** Migrations directory (defaults to src/db/migrations/historian). */
  migrationsDir?: string;
  nowMs?: () => number;
}

const SESSION_STATE_SQL = {
  select:
    "SELECT runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at FROM session_state WHERE runtime_session_id = ?",
  upsert:
    "INSERT INTO session_state (runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at) " +
    "VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(runtime_session_id) DO UPDATE SET " +
    "processed_through_entry_seq = excluded.processed_through_entry_seq, " +
    "status = excluded.status, " +
    "observed_head_entry_seq = excluded.observed_head_entry_seq, " +
    "updated_at = excluded.updated_at",
};

const BOUNDARY_SQL = {
  insert:
    "INSERT INTO boundary_snapshots " +
    "(boundary_snapshot_id, runtime_session_id, observed_head_entry_seq, eligible_through_entry_seq, " +
    "protected_tail_start_entry_seq, true_raw_eligible_tokens, narratable_eligible_tokens, " +
    "source_range_hash, model_provider_profile, frozen_at, consumed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) " +
    "ON CONFLICT(runtime_session_id, observed_head_entry_seq) DO UPDATE SET " +
    "eligible_through_entry_seq = excluded.eligible_through_entry_seq, " +
    "protected_tail_start_entry_seq = excluded.protected_tail_start_entry_seq, " +
    "true_raw_eligible_tokens = excluded.true_raw_eligible_tokens, " +
    "narratable_eligible_tokens = excluded.narratable_eligible_tokens, " +
    "source_range_hash = excluded.source_range_hash, " +
    "model_provider_profile = excluded.model_provider_profile, " +
    "frozen_at = excluded.frozen_at",
  selectBySession:
    "SELECT boundary_snapshot_id, runtime_session_id, observed_head_entry_seq, eligible_through_entry_seq, " +
    "protected_tail_start_entry_seq, true_raw_eligible_tokens, narratable_eligible_tokens, " +
    "source_range_hash, model_provider_profile, frozen_at, consumed_at " +
    "FROM boundary_snapshots WHERE runtime_session_id = ? ORDER BY observed_head_entry_seq DESC LIMIT ?",
};

const SNAPSHOT_SQL_INSERT =
  "INSERT INTO continuity_snapshots (continuity_snapshot_id, runtime_session_id, snapshot_sequence, " +
  "final_head_entry_seq, source_range_hash, snapshot_json, complete, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const SNAPSHOT_SQL_BY_SESSION =
  "SELECT snapshot_json FROM continuity_snapshots WHERE runtime_session_id = ? " +
  "ORDER BY snapshot_sequence DESC LIMIT ?";

export class HistorianStore {
  private readonly db: DatabaseSync;
  private readonly nowMs: () => number;
  private closed = false;

  private constructor(db: DatabaseSync, nowMs: () => number) {
    this.db = db;
    this.nowMs = nowMs;
  }

  /** Open (or create) historian.db, verifying the schema before use. */
  static open(options: HistorianStoreOptions): HistorianStore {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    // Migration runner: empty data root -> creates; upgrade -> applies only
    // missing forward-only versions; repeated -> idempotent; a changed
    // applied file or a NEWER schema -> throws (fail closed).
    migrateDatabase(options.databasePath, options.migrationsDir ?? historianMigrationsDir());
    const db = new DatabaseSync(options.databasePath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return new HistorianStore(db, options.nowMs ?? (() => Date.now()));
  }

  /** Reopen an existing DB (startup recovery). */
  static reopen(
    databasePath: string,
    migrationsDir?: string,
    nowMs?: () => number,
  ): HistorianStore {
    return HistorianStore.open({
      databasePath,
      ...(migrationsDir === undefined ? {} : { migrationsDir }),
      ...(nowMs === undefined ? {} : { nowMs }),
    });
  }

  getSessionState(runtimeSessionId: string): HistorianSessionState | undefined {
    const row = this.db.prepare(SESSION_STATE_SQL.select).get(runtimeSessionId) as
      | {
          runtime_session_id: string;
          processed_through_entry_seq: number;
          status: string;
          observed_head_entry_seq: number | null;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      runtimeSessionId: row.runtime_session_id,
      processedThroughEntrySeq: row.processed_through_entry_seq,
      status: row.status as HistorianSessionState["status"],
      ...(row.observed_head_entry_seq === null
        ? {}
        : { observedHeadEntrySeq: row.observed_head_entry_seq }),
      updatedAt: row.updated_at,
    };
  }

  upsertSessionState(state: HistorianSessionState): void {
    this.db
      .prepare(SESSION_STATE_SQL.upsert)
      .run(
        state.runtimeSessionId,
        state.processedThroughEntrySeq,
        state.status,
        state.observedHeadEntrySeq ?? null,
        state.updatedAt,
      );
  }

  saveBoundarySnapshot(snapshot: HistorianBoundarySnapshot): void {
    this.db
      .prepare(BOUNDARY_SQL.insert)
      .run(
        snapshot.boundarySnapshotId,
        snapshot.runtimeSessionId,
        snapshot.observedHeadEntrySeq,
        snapshot.eligibleThroughEntrySeq,
        snapshot.protectedTailStartEntrySeq,
        snapshot.trueRawEligibleTokens,
        snapshot.narratableEligibleTokens,
        snapshot.sourceRangeHash,
        snapshot.modelProviderProfile,
        snapshot.frozenAt,
      );
  }

  /** Latest boundary snapshots for a session (newest first). */
  listBoundarySnapshots(runtimeSessionId: string, limit = 1): HistorianBoundarySnapshot[] {
    const rows = this.db
      .prepare(BOUNDARY_SQL.selectBySession)
      .all(runtimeSessionId, limit) as Array<{
      boundary_snapshot_id: string;
      runtime_session_id: string;
      observed_head_entry_seq: number;
      eligible_through_entry_seq: number;
      protected_tail_start_entry_seq: number;
      true_raw_eligible_tokens: number;
      narratable_eligible_tokens: number;
      source_range_hash: string;
      model_provider_profile: string;
      frozen_at: string;
      consumed_at: string | null;
    }>;
    return rows.map((row) => ({
      boundarySnapshotId: row.boundary_snapshot_id,
      runtimeSessionId: row.runtime_session_id,
      observedHeadEntrySeq: row.observed_head_entry_seq,
      eligibleThroughEntrySeq: row.eligible_through_entry_seq,
      protectedTailStartEntrySeq: row.protected_tail_start_entry_seq,
      trueRawEligibleTokens: row.true_raw_eligible_tokens,
      narratableEligibleTokens: row.narratable_eligible_tokens,
      sourceRangeHash: row.source_range_hash,
      modelProviderProfile: row.model_provider_profile,
      frozenAt: row.frozen_at,
    }));
  }

  /** BEGIN a write transaction; the caller commits or rolls back. */
  begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
  }

  /** Insert an immutable compartment (B4; must run inside a transaction). */
  insertCompartment(compartment: HistoricalCompartment): void {
    this.db
      .prepare(
        "INSERT INTO compartments (compartment_id, runtime_session_id, compartment_sequence, " +
          "start_entry_seq, end_entry_seq, source_range_hash, content, p1, p2, p3, p4, " +
          "importance, episode_type, attribution_manifest_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        compartment.compartmentId,
        compartment.runtimeSessionId,
        compartment.compartmentSequence,
        compartment.startEntrySeq,
        compartment.endEntrySeq,
        compartment.sourceRangeHash,
        compartment.content,
        compartment.p1 ?? "",
        compartment.p2 ?? "",
        compartment.p3 ?? "",
        compartment.p4 ?? "",
        compartment.importance,
        compartment.episodeType,
        compartment.attributionManifestId,
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** Insert immutable segments (B4; must run inside a transaction). */
  insertSegments(segments: HistorianSegment[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO segments (segment_id, compartment_id, runtime_session_id, " +
        "start_entry_seq, end_entry_seq, source_range_hash, content, attribution_manifest_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date(this.nowMs()).toISOString();
    for (const segment of segments) {
      stmt.run(
        segment.segmentId,
        segment.compartmentId,
        segment.runtimeSessionId,
        segment.startEntrySeq,
        segment.endEntrySeq,
        segment.sourceRangeHash,
        segment.content,
        segment.attributionManifestId,
        now,
      );
    }
  }

  /** Insert an immutable evidence set (B4; never a summary/recall). */
  insertEvidenceSet(evidence: EvidenceSet): void {
    // R3 (anti-echo):evidence_basis_json/derived_only 由 0005 提供,旧库
    // 无列时保持旧行为(不伪造分类)。
    this.db
      .prepare(
        "INSERT INTO evidence_sets (evidence_set_id, runtime_session_id, compartment_id, " +
          "start_entry_seq, end_entry_seq, source_range_hash, entries_json, " +
          "evidence_basis_json, derived_only, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        evidence.evidenceSetId,
        evidence.runtimeSessionId,
        evidence.compartmentId,
        evidence.startEntrySeq,
        evidence.endEntrySeq,
        evidence.sourceRangeHash,
        JSON.stringify(evidence.entries),
        evidence.evidenceBasis !== undefined ? JSON.stringify(evidence.evidenceBasis) : null,
        evidence.derivedOnly !== undefined ? (evidence.derivedOnly ? 1 : 0) : null,
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** Insert an attribution manifest (B4; roles kept distinct). */
  insertAttributionManifest(manifest: AttributionManifest): void {
    this.db
      .prepare(
        "INSERT INTO attribution_manifests (attribution_manifest_id, runtime_session_id, " +
          "compartment_id, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        manifest.attributionManifestId,
        manifest.runtimeSessionId,
        manifest.compartmentId,
        JSON.stringify(manifest.attributions),
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** Highest committed compartment sequence for a session (B4 session-local
   * sequence continuity). */
  maxCompartmentSequence(runtimeSessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(compartment_sequence) AS max_seq FROM compartments WHERE runtime_session_id = ?",
      )
      .get(runtimeSessionId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  /** Insert the HistorianPublication row (B5; must run inside a
   * transaction). publicationSequence is MAX+1 allocated by the caller
   * INSIDE the commit transaction (never pre-allocated). */
  insertPublication(publication: PublicationRecord): void {
    this.db
      .prepare(
        "INSERT INTO publications (publication_sequence, publication_id, runtime_session_id, " +
          "processing_key, output_hash, compartment_ids_json, segment_ids_json, evidence_set_ids_json, " +
          "assessment_delta_ids_json, continuity_snapshot_id, previous_publication_sequence, " +
          "previous_session_processed_through_entry_seq, state, attempt_count, claim_leased_until, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        publication.publicationSequence,
        publication.publicationId,
        publication.runtimeSessionId,
        publication.processingKey,
        publication.outputHash,
        JSON.stringify(publication.compartmentIds),
        JSON.stringify(publication.segmentIds),
        JSON.stringify(publication.evidenceSetIds),
        JSON.stringify(publication.assessmentDeltaIds),
        publication.continuitySnapshotId,
        publication.previousPublicationSequence,
        publication.previousSessionProcessedThroughEntrySeq,
        publication.state,
        publication.attemptCount,
        publication.claimLeasedUntil,
        publication.createdAt,
        publication.updatedAt,
      );
  }

  /** Insert the authoritative publication_outbox row (B5; must run inside
   * the SAME transaction as the publication + cursor). */
  insertOutboxRow(row: Omit<OutboxRow, "outboxSequence">): void {
    this.db
      .prepare(
        "INSERT INTO publication_outbox (publication_id, runtime_session_id, payload_hash, state, " +
          "attempt_count, last_error_code, claim_leased_until, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.publicationId,
        row.runtimeSessionId,
        row.payloadHash,
        row.state,
        row.attemptCount,
        row.lastErrorCode,
        row.claimLeasedUntil,
        row.createdAt,
        row.updatedAt,
      );
  }

  /** Next session-local snapshot sequence (B6; monotonic per session). */
  nextSnapshotSequence(runtimeSessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(snapshot_sequence) AS max_seq FROM continuity_snapshots WHERE runtime_session_id = ?",
      )
      .get(runtimeSessionId) as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  /** Persist a ContinuitySnapshot (B6; must run inside a transaction). */
  insertContinuitySnapshot(snapshot: ContinuitySnapshot): void {
    this.db
      .prepare(SNAPSHOT_SQL_INSERT)
      .run(
        snapshot.continuitySnapshotId,
        snapshot.runtimeSessionId,
        snapshot.snapshotSequence,
        snapshot.finalHeadEntrySeq,
        snapshot.sourceRangeHash,
        JSON.stringify(snapshot),
        snapshot.complete ? 1 : 0,
        snapshot.createdAt,
      );
  }

  /** Latest continuity snapshots for a session (newest first, B6). */
  listContinuitySnapshots(runtimeSessionId: string, limit = 1): ContinuitySnapshot[] {
    const rows = this.db
      .prepare(SNAPSHOT_SQL_BY_SESSION)
      .all(runtimeSessionId, limit) as unknown as Array<{
      snapshot_json: string;
    }>;
    return rows
      .map((row) => JSON.parse(row.snapshot_json) as ContinuitySnapshot)
      .filter((snapshot) => snapshot !== undefined);
  }

  /** Persist a MemoryAssessmentDelta (B7; must run inside a transaction). */
  insertAssessmentDelta(delta: MemoryAssessmentDelta): void {
    this.db
      .prepare(
        "INSERT INTO memory_assessment_deltas (assessment_id, publication_sequence, runtime_session_id, " +
          "target_memory_ref, observed_in_invocation_ids_json, relation, basis_evidence_set_ids_json, " +
          "assessment_confidence, suggested_recall_disposition, rationale_code, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        delta.assessmentId,
        delta.publicationSequence,
        delta.runtimeSessionId,
        delta.targetMemoryRef,
        JSON.stringify(delta.observedInInvocationIds),
        delta.relation,
        JSON.stringify(delta.basisEvidenceSetIds),
        delta.assessmentConfidence,
        delta.suggestedRecallDisposition,
        delta.rationaleCode,
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** All session states (B8 startup recovery + health). */
  listSessions(): HistorianSessionState[] {
    const rows = this.db
      .prepare(
        "SELECT runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, updated_at FROM session_state ORDER BY updated_at",
      )
      .all() as unknown as Array<{
      runtime_session_id: string;
      processed_through_entry_seq: number;
      status: string;
      observed_head_entry_seq: number | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      runtimeSessionId: row.runtime_session_id,
      processedThroughEntrySeq: row.processed_through_entry_seq,
      status: row.status as HistorianSessionState["status"],
      ...(row.observed_head_entry_seq === null
        ? {}
        : { observedHeadEntrySeq: row.observed_head_entry_seq }),
      updatedAt: row.updated_at,
    }));
  }

  countSessions(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM session_state").get() as { n: number }).n;
  }

  countPublications(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM publications").get() as { n: number }).n;
  }

  countOutboxPending(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM publication_outbox WHERE state NOT IN ('delivered','quarantined')",
        )
        .get() as { n: number }
    ).n;
  }

  // ---- R3 hot-row reclaim (0004) -------------------------------------------

  /** 记录 compartment 释放条件(upsert;ACK 只追加不回退)。 */
  upsertCompartmentRelease(view: CompartmentReleaseView): void {
    this.db
      .prepare(
        `INSERT INTO compartment_release_state
          (compartment_id, runtime_session_id, compartment_sequence, start_entry_seq,
           end_entry_seq, publication_sequence, context_acked_at, bust_represented_at,
           memory_durable_ack_at, memory_receipt_hash, shard_id, shard_verified_at,
           reclaimed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(compartment_id) DO UPDATE SET
           context_acked_at = COALESCE(excluded.context_acked_at, compartment_release_state.context_acked_at),
           bust_represented_at = COALESCE(excluded.bust_represented_at, compartment_release_state.bust_represented_at),
           memory_durable_ack_at = COALESCE(excluded.memory_durable_ack_at, compartment_release_state.memory_durable_ack_at),
           memory_receipt_hash = COALESCE(excluded.memory_receipt_hash, compartment_release_state.memory_receipt_hash),
           shard_id = COALESCE(excluded.shard_id, compartment_release_state.shard_id),
           shard_verified_at = COALESCE(excluded.shard_verified_at, compartment_release_state.shard_verified_at),
           reclaimed_at = COALESCE(excluded.reclaimed_at, compartment_release_state.reclaimed_at)`,
      )
      .run(
        view.compartmentId,
        view.runtimeSessionId,
        view.compartmentSequence,
        view.startEntrySeq,
        view.endEntrySeq,
        view.publicationSequence,
        view.contextAckedAt,
        view.bustRepresentedAt,
        view.memoryDurableAckAt,
        view.memoryReceiptHash,
        view.shardId,
        view.shardVerifiedAt,
        view.reclaimedAt,
        new Date(this.now()).toISOString(),
      );
  }

  /** 列出某 session 未释放的 compartment 释放条件视图(升序)。 */
  listCompartmentReleaseViews(runtimeSessionId: string): CompartmentReleaseView[] {
    const rows = this.db
      .prepare(
        `SELECT compartment_id, runtime_session_id, compartment_sequence, start_entry_seq,
                end_entry_seq, publication_sequence, context_acked_at, bust_represented_at,
                memory_durable_ack_at, memory_receipt_hash, shard_id, shard_verified_at,
                reclaimed_at
         FROM compartment_release_state
         WHERE runtime_session_id = ? AND reclaimed_at IS NULL
         ORDER BY compartment_sequence`,
      )
      .all(runtimeSessionId) as unknown as Array<{
      compartment_id: string;
      runtime_session_id: string;
      compartment_sequence: number;
      start_entry_seq: number;
      end_entry_seq: number;
      publication_sequence: number | null;
      context_acked_at: string | null;
      bust_represented_at: string | null;
      memory_durable_ack_at: string | null;
      memory_receipt_hash: string | null;
      shard_id: string | null;
      shard_verified_at: string | null;
      reclaimed_at: string | null;
    }>;
    return rows.map((row) => ({
      compartmentId: row.compartment_id,
      runtimeSessionId: row.runtime_session_id,
      compartmentSequence: row.compartment_sequence,
      startEntrySeq: row.start_entry_seq,
      endEntrySeq: row.end_entry_seq,
      publicationSequence: row.publication_sequence,
      contextAckedAt: row.context_acked_at,
      bustRepresentedAt: row.bust_represented_at,
      memoryDurableAckAt: row.memory_durable_ack_at,
      memoryReceiptHash: row.memory_receipt_hash,
      shardId: row.shard_id,
      shardVerifiedAt: row.shard_verified_at,
      reclaimedAt: row.reclaimed_at,
    }));
  }

  /** 记录已 seal 的 archive shard(catalog,不可变)。 */
  insertArchiveShard(shard: {
    shardId: string;
    runtimeSessionId: string;
    firstCompartmentSequence: number;
    lastCompartmentSequence: number;
    shardPath: string;
    sha256: string;
    rowCount: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO archive_shards
          (shard_id, runtime_session_id, first_compartment_sequence, last_compartment_sequence,
           shard_path, sha256, row_count, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        shard.shardId,
        shard.runtimeSessionId,
        shard.firstCompartmentSequence,
        shard.lastCompartmentSequence,
        shard.shardPath,
        shard.sha256,
        shard.rowCount,
        new Date(this.now()).toISOString(),
      );
  }

  /** 标记 compartment 已释放(hot rows 已删除;只留 catalog 痕迹)。 */
  markReclaimed(compartmentId: string, at: string): void {
    this.db
      .prepare("UPDATE compartment_release_state SET reclaimed_at = ? WHERE compartment_id = ?")
      .run(at, compartmentId);
  }

  /** 物理删除已释放 compartment 的 hot rows(原子事务内调用)。 */
  deleteReclaimedHotRows(runtimeSessionId: string, compartmentId: string): void {
    this.db
      .prepare("DELETE FROM compartments WHERE compartment_id = ? AND runtime_session_id = ?")
      .run(compartmentId, runtimeSessionId);
    this.db.prepare("DELETE FROM segments WHERE compartment_id = ?").run(compartmentId);
    this.db.prepare("DELETE FROM evidence_sets WHERE compartment_id = ?").run(compartmentId);
    this.db
      .prepare("DELETE FROM attribution_manifests WHERE attribution_manifest_id = ?")
      .run(`am-${compartmentId.replace("compartment-", "")}`);
  }

  /** 已释放 compartment 数(审计)。 */
  countReclaimed(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM compartment_release_state WHERE reclaimed_at IS NOT NULL")
      .get() as { c: number };
    return row.c;
  }

  /** active hot compartments 数(平台期审计)。 */
  countActiveCompartments(runtimeSessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM compartment_release_state WHERE runtime_session_id = ? AND reclaimed_at IS NULL",
      )
      .get(runtimeSessionId) as { c: number };
    return row.c;
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  now(): number {
    return this.nowMs();
  }

  /** Raw DatabaseSync access for transactional composition (B5). */
  raw(): DatabaseSync {
    return this.db;
  }

  /** Convenience: hash of a JSON-serialized payload (deterministic). */
  static hash(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}

/** Absolute migrations dir for historian.db (works from dist + src). */
function historianMigrationsDir(): string {
  // dev: src/db/migrations/historian; dist: dist/db/migrations/historian
  // (scripts/copy-migrations.mjs copies the dir into dist).
  return fileURLToPath(new URL("../db/migrations/historian", import.meta.url));
}
