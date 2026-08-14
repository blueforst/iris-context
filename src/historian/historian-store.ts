/**
 * HistorianStore — Historian 自己的持久化（historian.db，Phase D）。
 *
 * v29 边界：
 *  - Historian 只消费 ContextHistoryReadPort 冻结的 HistorianBatchV1；
 *    绝不读取 Context repository，绝不写 Pi Session；
 *  - 每个 durable 写（batch claim/commit、Compartment、Publication、outbox、
 *    lineage cursor）在同一个原子事务内提交；
 *  - migrations forward-only、checksum 验证、幂等；更老的 schema（已应用版本
 *    不在迁移目录）fail-closed。
 *
 * 权威 cursor 是 lineage-scoped 的 `processedThroughContextSeq`（lineage_
 * cursors 表，跨 Session rollover 持久）；session_state 只作 attribution。
 * historian_batches 表持久化 claim/lease/commit 状态（commit protocol）。
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "../db/migrate.js";
import type { HistorianBatchV1, HistorianCursor } from "../contracts/historian.js";
import type { AttributionManifest, HistoricalCompartment } from "./historian-compartment.js";
import type { OutboxRow, PublicationRecord } from "./historian-publication.js";
import type { CompartmentReleaseView } from "./hot-row-reclaim.js";

export interface HistorianStoreOptions {
  /** historian.db path. */
  databasePath: string;
  /** Migrations directory (defaults to src/db/migrations/historian). */
  migrationsDir?: string;
  nowMs?: () => number;
}

/** historian_batches 的 claim/commit 状态（commit protocol）。 */
export type HistorianBatchState = "claimed" | "committed" | "skipped" | "failed";

/** historian_batches 物理行形状。 */
interface BatchRowShape {
  batch_id: string;
  claim_id: string;
  context_lineage_id: string;
  from_context_seq: number;
  through_context_seq: number;
  range_hash: string;
  semantic_schema_ids_json: string;
  unit_count: number;
  estimated_tokens: number;
  frozen_at: string;
  lease_expires_at: string;
  state: string;
  committed_at: string | null;
  receipt_id: string | null;
  receipt_json: string | null;
  acked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HistorianBatchRow {
  batchId: string;
  claimId: string;
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  semanticSchemaIds: string[];
  unitCount: number;
  estimatedTokens: number;
  frozenAt: string;
  leaseExpiresAt: string;
  state: HistorianBatchState;
  committedAt: string | null;
  receiptId: string | null;
  receiptJson: string | null;
  ackedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const SESSION_STATE_SQL = {
  select:
    "SELECT runtime_session_id, processed_through_entry_seq, processed_through_context_seq, status, observed_head_entry_seq, observed_head_context_seq, retry_attempts, retry_exhausted_at, updated_at FROM session_state WHERE runtime_session_id = ?",
  upsert:
    "INSERT INTO session_state (runtime_session_id, processed_through_entry_seq, processed_through_context_seq, status, observed_head_entry_seq, observed_head_context_seq, retry_attempts, retry_exhausted_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(runtime_session_id) DO UPDATE SET " +
    "processed_through_entry_seq = COALESCE(excluded.processed_through_entry_seq, session_state.processed_through_entry_seq), " +
    "processed_through_context_seq = COALESCE(excluded.processed_through_context_seq, session_state.processed_through_context_seq), " +
    "status = excluded.status, " +
    "observed_head_entry_seq = excluded.observed_head_entry_seq, " +
    "observed_head_context_seq = excluded.observed_head_context_seq, " +
    "retry_attempts = CASE WHEN excluded.retry_attempts = 0 THEN session_state.retry_attempts ELSE excluded.retry_attempts END, " +
    "retry_exhausted_at = COALESCE(session_state.retry_exhausted_at, excluded.retry_exhausted_at), " +
    "updated_at = excluded.updated_at",
  countExhausted:
    "SELECT COUNT(*) AS count FROM session_state WHERE retry_exhausted_at IS NOT NULL",
};

const LINEAGE_CURSOR_SQL = {
  select:
    "SELECT lineage_id, processed_through_context_seq, observed_head_context_seq, updated_at FROM lineage_cursors WHERE lineage_id = ?",
  upsert:
    "INSERT INTO lineage_cursors (lineage_id, processed_through_context_seq, observed_head_context_seq, updated_at) " +
    "VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(lineage_id) DO UPDATE SET " +
    "processed_through_context_seq = COALESCE(excluded.processed_through_context_seq, lineage_cursors.processed_through_context_seq), " +
    "observed_head_context_seq = excluded.observed_head_context_seq, " +
    "updated_at = excluded.updated_at",
};

export class HistorianStore {
  private readonly db: DatabaseSync;
  private readonly nowMs: () => number;
  private closed = false;

  private constructor(db: DatabaseSync, nowMs: () => number) {
    this.db = db;
    this.nowMs = nowMs;
  }

  /** Open (or create) historian.db，验证 schema 后再使用。 */
  static open(options: HistorianStoreOptions): HistorianStore {
    mkdirSync(dirname(options.databasePath), { recursive: true });
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

  // ---- session_state（attribution + durable retry accounting）-------------

  getSessionState(runtimeSessionId: string):
    | {
        runtimeSessionId: string;
        processedThroughEntrySeq: number;
        processedThroughContextSeq?: number;
        status: string;
        observedHeadEntrySeq?: number;
        observedHeadContextSeq?: number;
        retryAttempts?: number;
        retryExhaustedAt?: string;
        updatedAt: string;
      }
    | undefined {
    const row = this.db.prepare(SESSION_STATE_SQL.select).get(runtimeSessionId) as
      | {
          runtime_session_id: string;
          processed_through_entry_seq: number;
          processed_through_context_seq: number | null;
          status: string;
          observed_head_entry_seq: number | null;
          observed_head_context_seq: number | null;
          retry_attempts: number;
          retry_exhausted_at: string | null;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      runtimeSessionId: row.runtime_session_id,
      processedThroughEntrySeq: row.processed_through_entry_seq,
      ...(row.processed_through_context_seq === null
        ? {}
        : { processedThroughContextSeq: row.processed_through_context_seq }),
      status: row.status,
      ...(row.observed_head_entry_seq === null
        ? {}
        : { observedHeadEntrySeq: row.observed_head_entry_seq }),
      ...(row.observed_head_context_seq === null
        ? {}
        : { observedHeadContextSeq: row.observed_head_context_seq }),
      ...(row.retry_attempts > 0 ? { retryAttempts: row.retry_attempts } : {}),
      ...(row.retry_exhausted_at === null ? {} : { retryExhaustedAt: row.retry_exhausted_at }),
      updatedAt: row.updated_at,
    };
  }

  upsertSessionState(state: {
    runtimeSessionId: string;
    processedThroughEntrySeq?: number;
    processedThroughContextSeq?: number;
    status: string;
    observedHeadEntrySeq?: number;
    observedHeadContextSeq?: number;
    retryAttempts?: number;
    retryExhaustedAt?: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(SESSION_STATE_SQL.upsert)
      .run(
        state.runtimeSessionId,
        state.processedThroughEntrySeq ?? 0,
        state.processedThroughContextSeq ?? null,
        state.status,
        state.observedHeadEntrySeq ?? null,
        state.observedHeadContextSeq ?? null,
        state.retryAttempts ?? 0,
        state.retryExhaustedAt ?? null,
        state.updatedAt,
      );
  }

  /** 持久化一次失败的 attempt 计数（重试记账；只增不减）。 */
  recordRetryAttempt(runtimeSessionId: string, attempts: number): void {
    const current = this.getSessionState(runtimeSessionId);
    if (current === undefined) {
      return;
    }
    this.db
      .prepare(
        "UPDATE session_state SET retry_attempts = ?, updated_at = ? WHERE runtime_session_id = ?",
      )
      .run(attempts, new Date(this.nowMs()).toISOString(), runtimeSessionId);
  }

  /** 持久化 retry-exhausted 标记（设置一次；显式 reactivation 清除）。 */
  markRetryExhausted(runtimeSessionId: string): void {
    const current = this.getSessionState(runtimeSessionId);
    if (current === undefined) {
      return;
    }
    this.db
      .prepare(
        "UPDATE session_state SET retry_exhausted_at = ?, updated_at = ? WHERE runtime_session_id = ?",
      )
      .run(
        new Date(this.nowMs()).toISOString(),
        new Date(this.nowMs()).toISOString(),
        runtimeSessionId,
      );
  }

  /** 显式 operator reactivation：清除 exhausted 标记并重置计数。 */
  reactivateExhaustedSession(runtimeSessionId: string): boolean {
    const current = this.getSessionState(runtimeSessionId);
    if (current?.retryExhaustedAt === undefined) {
      return false;
    }
    const updated = this.db
      .prepare(
        "UPDATE session_state SET retry_exhausted_at = NULL, retry_attempts = 0, updated_at = ? WHERE runtime_session_id = ?",
      )
      .run(new Date(this.nowMs()).toISOString(), runtimeSessionId);
    return updated.changes === 1;
  }

  /** durable exhausted 计数（health）。 */
  countExhaustedSessions(): number {
    const row = this.db.prepare(SESSION_STATE_SQL.countExhausted).get() as { count: number };
    return row.count;
  }

  countSessions(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM session_state").get() as { n: number }).n;
  }

  listSessions(): Array<{
    runtimeSessionId: string;
    processedThroughEntrySeq: number;
    status: string;
    retryAttempts?: number;
    retryExhaustedAt?: string;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT runtime_session_id, processed_through_entry_seq, status, observed_head_entry_seq, retry_attempts, retry_exhausted_at, updated_at FROM session_state ORDER BY updated_at",
      )
      .all() as unknown as Array<{
      runtime_session_id: string;
      processed_through_entry_seq: number;
      status: string;
      observed_head_entry_seq: number | null;
      retry_attempts: number;
      retry_exhausted_at: string | null;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      runtimeSessionId: row.runtime_session_id,
      processedThroughEntrySeq: row.processed_through_entry_seq,
      status: row.status,
      ...(row.retry_attempts > 0 ? { retryAttempts: row.retry_attempts } : {}),
      ...(row.retry_exhausted_at === null ? {} : { retryExhaustedAt: row.retry_exhausted_at }),
      updatedAt: row.updated_at,
    }));
  }

  // ---- lineage-scoped cursor（AUTHORITATIVE）-------------------------------

  getLineageCursor(
    lineageId: string,
  ): { processedThroughContextSeq: number; observedHeadContextSeq: number } | undefined {
    const row = this.db.prepare(LINEAGE_CURSOR_SQL.select).get(lineageId) as
      | {
          lineage_id: string;
          processed_through_context_seq: number;
          observed_head_context_seq: number;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      processedThroughContextSeq: row.processed_through_context_seq,
      observedHeadContextSeq: row.observed_head_context_seq,
    };
  }

  /** Upsert lineage cursor。必须在与 Compartment/Publication 同一事务内调用。 */
  upsertLineageCursor(
    lineageId: string,
    processedThroughContextSeq: number | null,
    observedHeadContextSeq: number,
  ): void {
    this.db
      .prepare(LINEAGE_CURSOR_SQL.upsert)
      .run(
        lineageId,
        processedThroughContextSeq,
        observedHeadContextSeq,
        new Date(this.nowMs()).toISOString(),
      );
  }

  /** 权威 HistorianCursor（v29）：processedThroughContextSeq + 最近 compartment seq。 */
  getHistorianCursor(lineageId: string): HistorianCursor {
    const cursor = this.getLineageCursor(lineageId);
    return {
      processedThroughContextSeq: cursor?.processedThroughContextSeq ?? 0,
      lastCommittedCompartmentSequence: this.maxCompartmentSequence(lineageId),
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
  }

  // ---- historian_batches（claim/lease/commit protocol）--------------------

  /** Claim 一个冻结 batch（claim 幂等刷新 lease；claimId/lease 每次新建）。 */
  upsertBatchClaim(batch: HistorianBatchV1): void {
    const now = new Date(this.nowMs()).toISOString();
    this.db
      .prepare(
        `INSERT INTO historian_batches
          (batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq,
           range_hash, semantic_schema_ids_json, unit_count, estimated_tokens,
           frozen_at, lease_expires_at, state, committed_at, receipt_id, receipt_json,
           acked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(batch_id) DO UPDATE SET
           claim_id = excluded.claim_id,
           lease_expires_at = excluded.lease_expires_at,
           state = CASE WHEN historian_batches.state = 'committed'
                        THEN historian_batches.state ELSE excluded.state END,
           updated_at = excluded.updated_at`,
      )
      .run(
        batch.batchId,
        batch.claimId,
        batch.contextLineageId,
        batch.fromContextSeq,
        batch.throughContextSeq,
        batch.rangeHash,
        JSON.stringify(batch.semanticSchemaIds),
        batch.units.length,
        batch.estimatedTokens,
        batch.frozenAt,
        batch.leaseExpiresAt,
        now,
        now,
      );
  }

  /** 在 commit 事务内标记 batch committed（绑定完整 receipt）。 */
  markBatchCommitted(
    batchId: string,
    receipt: import("../contracts/historian.js").HistorianCommitReceiptV1,
  ): void {
    const now = new Date(this.nowMs()).toISOString();
    this.db
      .prepare(
        "UPDATE historian_batches SET state = 'committed', committed_at = ?, receipt_id = ?, receipt_json = ?, updated_at = ? WHERE batch_id = ?",
      )
      .run(now, receipt.receiptId, JSON.stringify(receipt), now, batchId);
  }

  /** 标记 batch 已 ACK（Context 幂等 ACK 后调用；启动只重放未 ACK 的）。 */
  markBatchAcked(batchId: string, at: string): void {
    this.db
      .prepare(
        "UPDATE historian_batches SET acked_at = ?, updated_at = ? WHERE batch_id = ? AND acked_at IS NULL",
      )
      .run(at, at, batchId);
  }

  /** 未 ACK 的 committed batches（commit 后 Context 未 ACK → 启动重放 receipt）。 */
  listCommittedBatchesNeedingAck(): HistorianBatchRow[] {
    const rows = this.db
      .prepare(
        "SELECT batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq, " +
          "range_hash, semantic_schema_ids_json, unit_count, estimated_tokens, " +
          "frozen_at, lease_expires_at, state, committed_at, receipt_id, receipt_json, acked_at, created_at, updated_at " +
          "FROM historian_batches WHERE state = 'committed' AND acked_at IS NULL " +
          "ORDER BY from_context_seq ASC",
      )
      .all() as unknown as BatchRowShape[];
    return rows.map((row) => this.batchRow(row));
  }

  /** 标记 batch failed（claim 后处理失败）。 */
  markBatchFailed(batchId: string): void {
    const now = new Date(this.nowMs()).toISOString();
    this.db
      .prepare("UPDATE historian_batches SET state = 'failed', updated_at = ? WHERE batch_id = ?")
      .run(now, batchId);
  }

  /**
   * 在 skip 事务内标记 batch skipped（全 exclude 窗口：无 Compartment/
   * Publication/outbox，cursor 仍按全窗口推进，避免 lineage 停摆）。
   */
  markBatchSkipped(batchId: string): void {
    const now = new Date(this.nowMs()).toISOString();
    this.db
      .prepare("UPDATE historian_batches SET state = 'skipped', updated_at = ? WHERE batch_id = ?")
      .run(now, batchId);
  }

  getBatch(batchId: string): HistorianBatchRow | undefined {
    const row = this.db
      .prepare(
        "SELECT batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq, " +
          "range_hash, semantic_schema_ids_json, unit_count, estimated_tokens, " +
          "frozen_at, lease_expires_at, state, committed_at, receipt_id, receipt_json, acked_at, created_at, updated_at " +
          "FROM historian_batches WHERE batch_id = ?",
      )
      .get(batchId) as BatchRowShape | undefined;
    if (row === undefined) {
      return undefined;
    }
    return this.batchRow(row);
  }

  /** lineage 最新 batch（按 from_context_seq 降序；供 compaction/审计）。 */
  listLatestBatchesByLineage(lineageId: string, limit = 1): HistorianBatchRow[] {
    const rows = this.db
      .prepare(
        "SELECT batch_id, claim_id, context_lineage_id, from_context_seq, through_context_seq, " +
          "range_hash, semantic_schema_ids_json, unit_count, estimated_tokens, " +
          "frozen_at, lease_expires_at, state, committed_at, receipt_id, receipt_json, acked_at, created_at, updated_at " +
          "FROM historian_batches WHERE context_lineage_id = ? ORDER BY from_context_seq DESC LIMIT ?",
      )
      .all(lineageId, limit) as unknown as BatchRowShape[];
    return rows.map((row) => this.batchRow(row));
  }

  private batchRow(row: BatchRowShape): HistorianBatchRow {
    const state = row.state as HistorianBatchState;
    if (state !== "claimed" && state !== "committed" && state !== "skipped" && state !== "failed") {
      throw new Error(
        `historian store: unknown batch state ${JSON.stringify(row.state)} (fail closed)`,
      );
    }
    return {
      batchId: row.batch_id,
      claimId: row.claim_id,
      contextLineageId: row.context_lineage_id,
      fromContextSeq: row.from_context_seq,
      throughContextSeq: row.through_context_seq,
      rangeHash: row.range_hash,
      semanticSchemaIds: JSON.parse(row.semantic_schema_ids_json) as string[],
      unitCount: row.unit_count,
      estimatedTokens: row.estimated_tokens,
      frozenAt: row.frozen_at,
      leaseExpiresAt: row.lease_expires_at,
      state,
      committedAt: row.committed_at,
      receiptId: row.receipt_id,
      receiptJson: row.receipt_json,
      ackedAt: row.acked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---- Compartment / Manifest --------------------------------------------

  /** 该 lineage 的最高已提交 compartment sequence（lineage-scoped 连续性）。 */
  maxCompartmentSequence(lineageId: string): number {
    const row = this.db
      .prepare("SELECT MAX(compartment_sequence) AS max_seq FROM compartments WHERE lineage_id = ?")
      .get(lineageId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  /** Insert 一个不可变 CompartmentRevision（须在事务内）。 */
  insertCompartment(compartment: HistoricalCompartment): void {
    this.db
      .prepare(
        "INSERT INTO compartments (compartment_id, runtime_session_id, lineage_id, compartment_sequence, " +
          "start_entry_seq, end_entry_seq, start_context_seq, end_context_seq, source_range_hash, content, p1, p2, p3, p4, " +
          "importance, episode_type, attribution_manifest_id, publication_sequence, created_at) " +
          "VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        compartment.compartmentId,
        compartment.runtimeSessionId,
        compartment.lineageId,
        compartment.compartmentSequence,
        compartment.startContextSeq,
        compartment.endContextSeq,
        compartment.sourceRangeHash,
        compartment.content,
        compartment.p1 ?? "",
        compartment.p2 ?? "",
        compartment.p3 ?? "",
        compartment.p4 ?? "",
        compartment.importance,
        compartment.episodeType,
        compartment.attributionManifestId,
        compartment.publicationSequence ?? null,
        new Date(this.nowMs()).toISOString(),
      );
  }

  /**
   * Phase E（canonical BUST P3）：读取某 lineage 的全部 committed
   * CompartmentRevision（values-only，不可变 VALUE；按 compartment_sequence
   * 升序 —— P3 projection 的确定性顺序）。compartments 表只在 Historian
   * commit 的原子事务内写入，因此所有行都是 committed；本方法不涉及任何
   * Context 状态，只把 Historian 拥有的 VALUE 暴露给 BUST coordinator。
   */
  listCommittedCompartments(lineageId: string): HistoricalCompartment[] {
    const rows = this.db
      .prepare(
        "SELECT compartment_id, runtime_session_id, lineage_id, compartment_sequence, " +
          "start_context_seq, end_context_seq, source_range_hash, content, p1, p2, p3, p4, " +
          "importance, episode_type, attribution_manifest_id, publication_sequence, created_at " +
          "FROM compartments WHERE lineage_id = ? ORDER BY compartment_sequence ASC",
      )
      .all(lineageId) as unknown as Array<{
      compartment_id: string;
      runtime_session_id: string;
      lineage_id: string;
      compartment_sequence: number;
      start_context_seq: number;
      end_context_seq: number;
      source_range_hash: string;
      content: string;
      p1: string;
      p2: string;
      p3: string;
      p4: string;
      importance: string;
      episode_type: string;
      attribution_manifest_id: string;
      publication_sequence: number | null;
      created_at: string;
    }>;
    return rows.map((row) => {
      const importance = row.importance as HistoricalCompartment["importance"];
      const episodeType = row.episode_type as HistoricalCompartment["episodeType"];
      if (
        !["low", "medium", "high", "critical"].includes(importance) ||
        !["request_response", "tool_execution", "maintenance"].includes(episodeType)
      ) {
        throw new Error(
          `historian store: compartment ${row.compartment_id} has unknown ` +
            `importance/episodeType (${JSON.stringify(row.importance)}/${JSON.stringify(row.episode_type)}) (fail closed)`,
        );
      }
      return {
        compartmentId: row.compartment_id,
        lineageId: row.lineage_id,
        runtimeSessionId: row.runtime_session_id,
        compartmentSequence: row.compartment_sequence,
        startContextSeq: row.start_context_seq,
        endContextSeq: row.end_context_seq,
        sourceRangeHash: row.source_range_hash,
        content: row.content,
        p1: row.p1,
        p2: row.p2,
        p3: row.p3,
        p4: row.p4,
        importance,
        episodeType,
        attributionManifestId: row.attribution_manifest_id,
        ...(row.publication_sequence !== null
          ? { publicationSequence: row.publication_sequence }
          : {}),
      };
    });
  }

  /** Insert 一个 attribution manifest（须在事务内；roles 保持区分）。 */
  insertAttributionManifest(manifest: AttributionManifest): void {
    this.db
      .prepare(
        "INSERT INTO attribution_manifests (attribution_manifest_id, runtime_session_id, " +
          "compartment_id, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        manifest.attributionManifestId,
        manifest.lineageId,
        manifest.compartmentId,
        JSON.stringify(manifest.attributions),
        new Date(this.nowMs()).toISOString(),
      );
  }

  // ---- Publication + outbox ----------------------------------------------

  /** Insert 一条 HistorianPublication（须在 commit 事务内；MAX+1 由调用方分配）。 */
  insertPublication(publication: PublicationRecord): void {
    this.db
      .prepare(
        "INSERT INTO publications (publication_sequence, publication_id, runtime_session_id, " +
          "processing_key, output_hash, compartment_ids_json, segment_ids_json, evidence_set_ids_json, " +
          "assessment_delta_ids_json, continuity_snapshot_id, previous_publication_sequence, " +
          "previous_session_processed_through_entry_seq, state, attempt_count, claim_leased_until, " +
          "batch_id, claim_id, lineage_id, from_context_seq, through_context_seq, range_hash, " +
          "processing_profile_id, observations_json, compartment_revisions_json, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        publication.publicationSequence,
        publication.publicationId,
        publication.runtimeSessionId,
        `batch:${publication.batchId}:${publication.fromContextSeq}-${publication.throughContextSeq}:${publication.rangeHash}`,
        publication.outputHash,
        JSON.stringify(publication.compartmentIds),
        "[]",
        "[]",
        null,
        null,
        publication.previousPublicationSequence,
        null,
        publication.state,
        publication.attemptCount,
        publication.claimLeasedUntil,
        publication.batchId,
        publication.claimId,
        publication.lineageId,
        publication.fromContextSeq,
        publication.throughContextSeq,
        publication.rangeHash,
        publication.processingProfileId,
        publication.observationsJson,
        publication.compartmentRevisionsJson,
        publication.createdAt,
        publication.updatedAt,
      );
  }

  /** Insert 权威 outbox 行（与 publication/cursor 同一事务）。 */
  insertOutboxRow(row: Omit<OutboxRow, "outboxSequence">): void {
    this.db
      .prepare(
        "INSERT INTO publication_outbox (publication_id, runtime_session_id, payload_hash, payload_json, state, " +
          "attempt_count, last_error_code, claim_leased_until, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.publicationId,
        row.runtimeSessionId,
        row.payloadHash,
        row.payloadJson ?? null,
        row.state,
        row.attemptCount,
        row.lastErrorCode,
        row.claimLeasedUntil,
        row.createdAt,
        row.updatedAt,
      );
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

  // ---- hot-row reclaim（0004；contextSeq 坐标）------------------------------

  /** 记录 compartment 释放条件（upsert；ACK 只追加不回退）。 */
  upsertCompartmentRelease(view: CompartmentReleaseView): void {
    this.db
      .prepare(
        `INSERT INTO compartment_release_state
          (compartment_id, runtime_session_id, compartment_sequence, start_entry_seq,
           end_entry_seq, start_context_seq, end_context_seq, publication_sequence, context_acked_at,
           bust_represented_at, memory_durable_ack_at, memory_receipt_hash, shard_id,
           shard_verified_at, reclaimed_at, created_at)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        view.startContextSeq,
        view.endContextSeq,
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

  /** 列出某 lineage 未释放的 compartment 释放条件视图（升序）。 */
  listCompartmentReleaseViews(lineageId: string): CompartmentReleaseView[] {
    const rows = this.db
      .prepare(
        `SELECT r.compartment_id, r.runtime_session_id, r.compartment_sequence,
                r.start_entry_seq, r.end_entry_seq, r.start_context_seq, r.end_context_seq,
                r.publication_sequence, r.context_acked_at, r.bust_represented_at,
                r.memory_durable_ack_at, r.memory_receipt_hash,
                r.shard_id, r.shard_verified_at, r.reclaimed_at,
                p.delivered_receipt_publication_id, p.delivered_canonical_payload_hash,
                p.delivered_receipt_id, p.delivered_contract_version
         FROM compartment_release_state r
         LEFT JOIN publications p ON p.publication_sequence = r.publication_sequence
         WHERE r.runtime_session_id = ? AND r.reclaimed_at IS NULL
         ORDER BY r.compartment_sequence`,
      )
      .all(lineageId) as unknown as Array<{
      compartment_id: string;
      runtime_session_id: string;
      compartment_sequence: number;
      start_entry_seq: number;
      end_entry_seq: number;
      start_context_seq: number | null;
      end_context_seq: number | null;
      publication_sequence: number | null;
      context_acked_at: string | null;
      bust_represented_at: string | null;
      memory_durable_ack_at: string | null;
      memory_receipt_hash: string | null;
      shard_id: string | null;
      shard_verified_at: string | null;
      reclaimed_at: string | null;
      delivered_receipt_publication_id: string | null;
      delivered_canonical_payload_hash: string | null;
      delivered_receipt_id: string | null;
      delivered_contract_version: string | null;
    }>;
    return rows.map((row) => ({
      compartmentId: row.compartment_id,
      runtimeSessionId: row.runtime_session_id,
      compartmentSequence: row.compartment_sequence,
      startContextSeq: row.start_context_seq ?? row.start_entry_seq,
      endContextSeq: row.end_context_seq ?? row.end_entry_seq,
      publicationSequence: row.publication_sequence,
      contextAckedAt: row.context_acked_at,
      bustRepresentedAt: row.bust_represented_at,
      memoryDurableAckAt: row.memory_durable_ack_at,
      memoryReceiptHash: row.memory_receipt_hash,
      deliveredReceiptId: row.delivered_receipt_id,
      deliveredReceiptPublicationId: row.delivered_receipt_publication_id,
      deliveredCanonicalPayloadHash: row.delivered_canonical_payload_hash,
      deliveredContractVersion: row.delivered_contract_version,
      shardId: row.shard_id,
      shardVerifiedAt: row.shard_verified_at,
      reclaimedAt: row.reclaimed_at,
    }));
  }

  /** 记录已 seal 的 archive shard（catalog，不可变）。 */
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

  /** 标记 compartment 已释放（hot rows 已删；只留 catalog 痕迹）。 */
  markReclaimed(compartmentId: string, at: string): void {
    this.db
      .prepare("UPDATE compartment_release_state SET reclaimed_at = ? WHERE compartment_id = ?")
      .run(at, compartmentId);
  }

  /** 物理删除已释放 compartment 的 hot rows（原子事务内调用）。 */
  deleteReclaimedHotRows(lineageId: string, compartmentId: string): void {
    this.db
      .prepare("DELETE FROM compartments WHERE compartment_id = ? AND lineage_id = ?")
      .run(compartmentId, lineageId);
    this.db
      .prepare("DELETE FROM attribution_manifests WHERE attribution_manifest_id = ?")
      .run(`am-${compartmentId.replace("compartment-", "")}`);
  }

  /** 已释放 compartment 数（审计）。 */
  countReclaimed(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM compartment_release_state WHERE reclaimed_at IS NOT NULL")
      .get() as { c: number };
    return row.c;
  }

  /** active hot compartments 数（平台期审计）。 */
  countActiveCompartments(lineageId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM compartment_release_state WHERE runtime_session_id = ? AND reclaimed_at IS NULL",
      )
      .get(lineageId) as { c: number };
    return row.c;
  }

  // ---- transaction / lifecycle -------------------------------------------

  begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
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

  /** Raw DatabaseSync access for transactional composition. */
  raw(): DatabaseSync {
    return this.db;
  }

  /** Convenience: deterministic sha256 of a JSON-serialized payload. */
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
  return fileURLToPath(new URL("../db/migrations/historian", import.meta.url));
}
