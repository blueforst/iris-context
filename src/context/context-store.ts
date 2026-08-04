import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "../db/migrate.js";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextMessageUnit } from "../contracts/context-units.js";
import type { ContextUnitStorePort } from "./context-ingest.js";

interface UnitRow {
  runtime_session_id: string;
  context_seq: number;
  unit_id: string;
  source_event_id: string;
  unit_type: string;
  disposition: string;
  entry_id: string | null;
  entry_seq: number | null;
  content_hash: string;
  payload: string;
  companion_entry_id: string | null;
  pair_key: string | null;
  paired: number;
  derivation_refs: string;
  created_at: string;
}

/**
 * Schema version of the Context domain model. Every migration file under
 * src/db/migrations/context/ must be applied in order; the store fails closed
 * if the on-disk schema_migrations.max(version) is NEWER than this constant
 * (a newer binary wrote state this binary cannot read).
 */
export const LATEST_MIGRATION_VERSION = "0002_units";

export interface ContextLineage {
  runtimeSessionId: string;
  contextSourceSnapshotId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  continuitySeedId?: string;
  runtimeRecoveryNoticeId?: string;
  stableMemoryPoolVersion?: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
  materializationId: string;
  contextSerializerVersion: string;
  carrierSchemaVersion: string;
  m0Body: string | null;
  m1Body: string | null;
  m0ContentHash: string | null;
  m1ContentHash: string | null;
  m0MaterializedAt: number | null;
  m1UpdatedAt: number | null;
  cachedM0SystemHash: string | null;
  cachedM0ModelKey: string | null;
  cachedM0ProviderProfileId: string | null;
  lastResponseTime: number | null;
  representedThroughEntrySeq: number;
  protectedTailStartEntrySeq: number | null;
  lastSafeUserAnchorEntrySeq: number | null;
  clearedReasoningThroughTag: number;
  toolReclaimWatermark: number;
  mutationReplayWatermark: number;
  deferredSignalCursor: number;
  emergencyState: "ok" | "transform_unavailable" | "emergency_fail_closed";
  lastTransformError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLineageInput {
  runtimeSessionId: string;
  contextSourceSnapshotId: string;
  epochId: string;
  personaSnapshotId: string;
  declarationVersion: string;
  providerProfileId: string;
  canonicalSystemPrompt: string;
  systemProjectionHash: string;
  preparedAt: string;
  materializationId: string;
  contextSerializerVersion: string;
  carrierSchemaVersion: string;
}

export interface MaterializeM0Input {
  runtimeSessionId: string;
  m0Body: string;
  m1Body: string;
  m0ContentHash: string;
  m1ContentHash: string;
  cachedM0SystemHash: string;
  cachedM0ModelKey: string;
  cachedM0ProviderProfileId: string;
  representedThroughEntrySeq: number;
  protectedTailStartEntrySeq: number;
  lastSafeUserAnchorEntrySeq: number;
  atMs: number;
}

export interface MaterializeM1Input {
  runtimeSessionId: string;
  m1Body: string;
  m1ContentHash: string;
  representedThroughEntrySeq: number;
  atMs: number;
}

interface LineageRow {
  runtime_session_id: string;
  context_source_snapshot_id: string;
  epoch_id: string;
  persona_snapshot_id: string;
  declaration_version: string;
  continuity_seed_id: string | null;
  runtime_recovery_notice_id: string | null;
  stable_memory_pool_version: string | null;
  provider_profile_id: string;
  canonical_system_prompt: string;
  system_projection_hash: string;
  prepared_at: string;
  materialization_id: string;
  context_serializer_version: string;
  carrier_schema_version: string;
  m0_body: string | null;
  m1_body: string | null;
  m0_content_hash: string | null;
  m1_content_hash: string | null;
  m0_materialized_at: number | null;
  m1_updated_at: number | null;
  cached_m0_system_hash: string | null;
  cached_m0_model_key: string | null;
  cached_m0_provider_profile_id: string | null;
  last_response_time: number | null;
  represented_through_entry_seq: number;
  protected_tail_start_entry_seq: number | null;
  last_safe_user_anchor_entry_seq: number | null;
  cleared_reasoning_through_tag: number;
  tool_reclaim_watermark: number;
  mutation_replay_watermark: number;
  deferred_signal_cursor: number;
  emergency_state: string;
  last_transform_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToLineage(row: LineageRow): ContextLineage {
  const base: ContextLineage = {
    runtimeSessionId: row.runtime_session_id,
    contextSourceSnapshotId: row.context_source_snapshot_id,
    epochId: row.epoch_id,
    personaSnapshotId: row.persona_snapshot_id,
    declarationVersion: row.declaration_version,
    providerProfileId: row.provider_profile_id,
    canonicalSystemPrompt: row.canonical_system_prompt,
    systemProjectionHash: row.system_projection_hash,
    preparedAt: row.prepared_at,
    materializationId: row.materialization_id,
    contextSerializerVersion: row.context_serializer_version,
    carrierSchemaVersion: row.carrier_schema_version,
    m0Body: row.m0_body,
    m1Body: row.m1_body,
    m0ContentHash: row.m0_content_hash,
    m1ContentHash: row.m1_content_hash,
    m0MaterializedAt: row.m0_materialized_at,
    m1UpdatedAt: row.m1_updated_at,
    cachedM0SystemHash: row.cached_m0_system_hash,
    cachedM0ModelKey: row.cached_m0_model_key,
    cachedM0ProviderProfileId: row.cached_m0_provider_profile_id,
    lastResponseTime: row.last_response_time,
    representedThroughEntrySeq: row.represented_through_entry_seq,
    protectedTailStartEntrySeq: row.protected_tail_start_entry_seq,
    lastSafeUserAnchorEntrySeq: row.last_safe_user_anchor_entry_seq,
    clearedReasoningThroughTag: row.cleared_reasoning_through_tag,
    toolReclaimWatermark: row.tool_reclaim_watermark,
    mutationReplayWatermark: row.mutation_replay_watermark,
    deferredSignalCursor: row.deferred_signal_cursor,
    emergencyState: row.emergency_state as ContextLineage["emergencyState"],
    lastTransformError: row.last_transform_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return base;
}

export interface DeferredOperation {
  seq: number;
  runtimeSessionId: string;
  opKind: string;
  opPayload: string;
  enqueuedAt: string;
}

export interface LkgSlot {
  runtimeSessionId: string;
  slotKey: string;
  lkgJson: string;
  capturedAt: string;
}

/**
 * Session-scoped Context SQLite authority. One ContextStore owns context.db.
 *
 * Fail-closed rules:
 *  - newer schema (on-disk max version > LATEST_MIGRATION_VERSION) → throw;
 *  - storage unavailable (open/migration failure) → throw;
 *  - materialization commits are single-row transactions: a failed write
 *    never partially advances m0/m1 state.
 *
 * Context.db is REBUILDABLE from durable state (Pi Session + ingested
 * sources): the in-memory cache may be dropped, SQLite state is the
 * transform authority. It never stores a second copy of raw Pi messages.
 */
export class ContextStore implements ContextUnitStorePort {
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(contextDbPath: string): ContextStore {
    try {
      mkdirSync(dirname(contextDbPath), { recursive: true });
    } catch {
      // dirname of a bare filename is "." — always creatable.
    }
    const db = new DatabaseSync(contextDbPath);
    try {
      // Busy timeout before WAL so a transient writer (e.g. a diagnostic tool
      // opening context.db concurrently) waits instead of failing SQLITE_BUSY
      // (reviewer F2). The Host's data-root lock still guarantees a single
      // writer in production; this is defense-in-depth.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(contextDbPath, migrationsDirFor(contextDbPath));
      // Newer-schema fence: after migrations run, the on-disk max version must
      // not exceed what THIS binary knows. migrateDatabase() already throws on
      // checksum drift; this catches the "newer binary wrote state" case.
      const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        { version: string | null } | undefined;
      const maxVersion = row?.version;
      if (
        maxVersion !== null &&
        maxVersion !== undefined &&
        maxVersion !== LATEST_MIGRATION_VERSION
      ) {
        // Files are lexicographically ordered; the max is the last applied.
        const all = db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as unknown as Array<{ version: string }>;
        const last = all[all.length - 1]?.version;
        if (last !== undefined && last !== LATEST_MIGRATION_VERSION) {
          db.close();
          throw new Error(
            `context.db schema ${last} is newer than supported ${LATEST_MIGRATION_VERSION} — ` +
              "refusing to open (fail closed); upgrade the Host binary",
          );
        }
      }
      return new ContextStore(db);
    } catch (error) {
      try {
        db.close();
      } catch {
        // already closed
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  // ---- R2: ContextMessageUnit 持久化（context_units 表，ContextUnitStorePort）----

  hasUnitForEvent(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM context_units WHERE source_event_id = ? LIMIT 1")
      .get(eventId) as { hit: number } | undefined;
    return row !== undefined;
  }

  insertUnit(unit: ContextMessageUnit): void {
    this.db
      .prepare(
        `INSERT INTO context_units (
           runtime_session_id, context_seq, unit_id, source_event_id, unit_type,
           disposition, entry_id, entry_seq, content_hash, payload,
           companion_entry_id, pair_key, paired, derivation_refs, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        unit.runtimeSessionId,
        unit.contextSeq,
        unit.unitId,
        unit.sourceEventId,
        unit.unitType,
        unit.disposition,
        unit.entryId ?? null,
        unit.entrySeq ?? null,
        unit.contentHash,
        JSON.stringify(unit.payload),
        unit.companionEntryId ?? null,
        unit.pairKey ?? null,
        unit.paired ? 1 : 0,
        JSON.stringify(unit.derivationRefs),
        unit.createdAt,
      );
  }

  updateUnitPairing(
    runtimeSessionId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
  ): void {
    const result = this.db
      .prepare(
        `UPDATE context_units SET
           companion_entry_id = ?, pair_key = ?, paired = ?, payload = ?
         WHERE runtime_session_id = ? AND context_seq = ?`,
      )
      .run(
        update.companionEntryId,
        update.pairKey,
        update.paired ? 1 : 0,
        JSON.stringify(update.payload),
        runtimeSessionId,
        contextSeq,
      );
    if (result.changes !== 1) {
      throw new Error(
        `context updateUnitPairing failed: no unit ${runtimeSessionId}/${contextSeq}`,
      );
    }
  }

  listUnits(
    runtimeSessionId: string,
    options: { afterContextSeq?: number; limit?: number } = {},
  ): ContextMessageUnit[] {
    const rows = (options.afterContextSeq === undefined
      ? this.db
          .prepare("SELECT * FROM context_units WHERE runtime_session_id = ? ORDER BY context_seq")
          .all(runtimeSessionId)
      : this.db
          .prepare(
            "SELECT * FROM context_units WHERE runtime_session_id = ? AND context_seq > ? ORDER BY context_seq",
          )
          .all(runtimeSessionId, options.afterContextSeq)) as unknown as UnitRow[];
    const limit = options.limit ?? rows.length;
    return rows.slice(0, limit).map((row) => this.rowToUnit(row));
  }

  lastUnpairedInputSeq(runtimeSessionId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(context_seq) AS seq FROM context_units
         WHERE runtime_session_id = ? AND unit_type = 'input' AND paired = 0`,
      )
      .get(runtimeSessionId) as { seq: number | null } | undefined;
    const seq = row?.seq;
    return seq ?? undefined;
  }

  findBySourceEvent(eventId: string): ContextMessageUnit | undefined {
    const row = this.db
      .prepare("SELECT * FROM context_units WHERE source_event_id = ? LIMIT 1")
      .get(eventId) as UnitRow | undefined;
    return row === undefined ? undefined : this.rowToUnit(row);
  }

  maxContextSeq(runtimeSessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(context_seq), 0) AS seq FROM context_units WHERE runtime_session_id = ?",
      )
      .get(runtimeSessionId) as { seq: number };
    return row.seq;
  }

  private rowToUnit(row: UnitRow): ContextMessageUnit {
    return {
      runtimeSessionId: row.runtime_session_id,
      contextSeq: row.context_seq,
      unitId: row.unit_id,
      sourceEventId: row.source_event_id,
      unitType: row.unit_type as ContextMessageUnit["unitType"],
      disposition: row.disposition as ContextMessageUnit["disposition"],
      ...(row.entry_id !== null ? { entryId: row.entry_id } : {}),
      ...(row.entry_seq !== null ? { entrySeq: row.entry_seq } : {}),
      contentHash: row.content_hash,
      payload: JSON.parse(row.payload) as AgentMessage,
      ...(row.companion_entry_id !== null ? { companionEntryId: row.companion_entry_id } : {}),
      ...(row.pair_key !== null ? { pairKey: row.pair_key } : {}),
      paired: row.paired === 1,
      derivationRefs: JSON.parse(row.derivation_refs) as ContextMessageUnit["derivationRefs"],
      createdAt: row.created_at,
    };
  }

  /** Raw prepared-statement access for the replay/consumer layers. */
  raw(): DatabaseSync {
    return this.db;
  }

  createLineage(input: CreateLineageInput): ContextLineage {
    const now = new Date().toISOString();
    const row: LineageRow = {
      runtime_session_id: input.runtimeSessionId,
      context_source_snapshot_id: input.contextSourceSnapshotId,
      epoch_id: input.epochId,
      persona_snapshot_id: input.personaSnapshotId,
      declaration_version: input.declarationVersion,
      continuity_seed_id: null,
      runtime_recovery_notice_id: null,
      stable_memory_pool_version: null,
      provider_profile_id: input.providerProfileId,
      canonical_system_prompt: input.canonicalSystemPrompt,
      system_projection_hash: input.systemProjectionHash,
      prepared_at: input.preparedAt,
      materialization_id: input.materializationId,
      context_serializer_version: input.contextSerializerVersion,
      carrier_schema_version: input.carrierSchemaVersion,
      m0_body: null,
      m1_body: null,
      m0_content_hash: null,
      m1_content_hash: null,
      m0_materialized_at: null,
      m1_updated_at: null,
      cached_m0_system_hash: null,
      cached_m0_model_key: null,
      cached_m0_provider_profile_id: null,
      last_response_time: null,
      represented_through_entry_seq: 0,
      protected_tail_start_entry_seq: null,
      last_safe_user_anchor_entry_seq: null,
      cleared_reasoning_through_tag: 0,
      tool_reclaim_watermark: 0,
      mutation_replay_watermark: 0,
      deferred_signal_cursor: 0,
      emergency_state: "ok",
      last_transform_error: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO context_lineages (
          runtime_session_id, context_source_snapshot_id, epoch_id, persona_snapshot_id,
          declaration_version, continuity_seed_id, runtime_recovery_notice_id,
          stable_memory_pool_version, provider_profile_id, canonical_system_prompt,
          system_projection_hash, prepared_at, materialization_id,
          context_serializer_version, carrier_schema_version,
          m0_body, m1_body, m0_content_hash, m1_content_hash,
          m0_materialized_at, m1_updated_at,
          cached_m0_system_hash, cached_m0_model_key, cached_m0_provider_profile_id,
          last_response_time, represented_through_entry_seq,
          protected_tail_start_entry_seq, last_safe_user_anchor_entry_seq,
          cleared_reasoning_through_tag, tool_reclaim_watermark,
          mutation_replay_watermark, deferred_signal_cursor,
          emergency_state, last_transform_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runtime_session_id,
        row.context_source_snapshot_id,
        row.epoch_id,
        row.persona_snapshot_id,
        row.declaration_version,
        row.continuity_seed_id,
        row.runtime_recovery_notice_id,
        row.stable_memory_pool_version,
        row.provider_profile_id,
        row.canonical_system_prompt,
        row.system_projection_hash,
        row.prepared_at,
        row.materialization_id,
        row.context_serializer_version,
        row.carrier_schema_version,
        row.m0_body,
        row.m1_body,
        row.m0_content_hash,
        row.m1_content_hash,
        row.m0_materialized_at,
        row.m1_updated_at,
        row.cached_m0_system_hash,
        row.cached_m0_model_key,
        row.cached_m0_provider_profile_id,
        row.last_response_time,
        row.represented_through_entry_seq,
        row.protected_tail_start_entry_seq,
        row.last_safe_user_anchor_entry_seq,
        row.cleared_reasoning_through_tag,
        row.tool_reclaim_watermark,
        row.mutation_replay_watermark,
        row.deferred_signal_cursor,
        row.emergency_state,
        row.last_transform_error,
        row.created_at,
        row.updated_at,
      );
    return rowToLineage(row);
  }

  getLineage(runtimeSessionId: string): ContextLineage | undefined {
    const row = this.db
      .prepare("SELECT * FROM context_lineages WHERE runtime_session_id = ?")
      .get(runtimeSessionId) as LineageRow | undefined;
    return row === undefined ? undefined : rowToLineage(row);
  }

  /**
   * HARD materialization: (re)build m0 + reset m1 atomically. A failure here
   * must not leave m0 advanced while m1 is stale — single-row transaction.
   */
  materializeM0(input: MaterializeM0Input): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           m0_body = ?, m1_body = ?, m0_content_hash = ?, m1_content_hash = ?,
           m0_materialized_at = ?, m1_updated_at = ?,
           cached_m0_system_hash = ?, cached_m0_model_key = ?,
           cached_m0_provider_profile_id = ?,
           represented_through_entry_seq = ?,
           protected_tail_start_entry_seq = ?,
           last_safe_user_anchor_entry_seq = ?,
           updated_at = ?
         WHERE runtime_session_id = ?`,
      )
      .run(
        input.m0Body,
        input.m1Body,
        input.m0ContentHash,
        input.m1ContentHash,
        input.atMs,
        input.atMs,
        input.cachedM0SystemHash,
        input.cachedM0ModelKey,
        input.cachedM0ProviderProfileId,
        input.representedThroughEntrySeq,
        input.protectedTailStartEntrySeq,
        input.lastSafeUserAnchorEntrySeq,
        now,
        input.runtimeSessionId,
      );
    if (result.changes !== 1) {
      throw new Error(
        `context materializeM0 failed: no lineage for ${input.runtimeSessionId} (fail closed)`,
      );
    }
  }

  /** SOFT materialization: update only m1 (m0 stays byte-identical). */
  materializeM1(input: MaterializeM1Input): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           m1_body = ?, m1_content_hash = ?, m1_updated_at = ?,
           represented_through_entry_seq = ?,
           updated_at = ?
         WHERE runtime_session_id = ?`,
      )
      .run(
        input.m1Body,
        input.m1ContentHash,
        input.atMs,
        input.representedThroughEntrySeq,
        now,
        input.runtimeSessionId,
      );
    if (result.changes !== 1) {
      throw new Error(
        `context materializeM1 failed: no lineage for ${input.runtimeSessionId} (fail closed)`,
      );
    }
  }

  setEmergencyState(
    runtimeSessionId: string,
    state: ContextLineage["emergencyState"],
    error: string | null,
  ): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET emergency_state = ?, last_transform_error = ?, updated_at = ?
         WHERE runtime_session_id = ?`,
      )
      .run(state, error, now, runtimeSessionId);
    if (result.changes !== 1) {
      throw new Error(`context setEmergencyState failed: no lineage for ${runtimeSessionId}`);
    }
  }

  /**
   * Persist advanced replay watermarks (monotonic single-row update). The
   * caller commits detect results ONLY on a cache-busting pass — a defer pass
   * must never advance these (byte-identical replay contract).
   */
  persistWatermarks(
    runtimeSessionId: string,
    watermarks: {
      clearedReasoningThroughTag: number;
      toolReclaimWatermark: number;
      mutationReplayWatermark: number;
    },
  ): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE context_lineages SET
           cleared_reasoning_through_tag = ?, tool_reclaim_watermark = ?,
           mutation_replay_watermark = ?, updated_at = ?
         WHERE runtime_session_id = ?`,
      )
      .run(
        watermarks.clearedReasoningThroughTag,
        watermarks.toolReclaimWatermark,
        watermarks.mutationReplayWatermark,
        now,
        runtimeSessionId,
      );
    if (result.changes !== 1) {
      throw new Error(`context persistWatermarks failed: no lineage for ${runtimeSessionId}`);
    }
  }

  enqueueDeferredOperation(
    runtimeSessionId: string,
    opKind: string,
    opPayload: string,
  ): DeferredOperation {
    const now = new Date().toISOString();
    const lineage = this.getLineage(runtimeSessionId);
    if (lineage === undefined) {
      throw new Error(`context enqueueDeferred failed: no lineage for ${runtimeSessionId}`);
    }
    const cursor = lineage.deferredSignalCursor;
    const result = this.db
      .prepare(
        `INSERT INTO context_deferred_operations
           (runtime_session_id, op_kind, op_payload, enqueued_at, consumed_after_cursor)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runtimeSessionId, opKind, opPayload, now, cursor);
    return {
      seq: Number(result.lastInsertRowid),
      runtimeSessionId,
      opKind,
      opPayload,
      enqueuedAt: now,
    };
  }

  listDeferredOperations(runtimeSessionId: string): DeferredOperation[] {
    const rows = this.db
      .prepare(
        "SELECT seq, runtime_session_id, op_kind, op_payload, enqueued_at FROM context_deferred_operations WHERE runtime_session_id = ? ORDER BY seq",
      )
      .all(runtimeSessionId) as unknown as Array<{
      seq: number;
      runtime_session_id: string;
      op_kind: string;
      op_payload: string;
      enqueued_at: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      runtimeSessionId: row.runtime_session_id,
      opKind: row.op_kind,
      opPayload: row.op_payload,
      enqueuedAt: row.enqueued_at,
    }));
  }

  setDeferredSignalCursor(runtimeSessionId: string, cursor: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE context_lineages SET deferred_signal_cursor = ?, updated_at = ? WHERE runtime_session_id = ?",
      )
      .run(cursor, now, runtimeSessionId);
  }

  captureLkgSlot(slot: LkgSlot): void {
    const result = this.db
      .prepare(
        `INSERT INTO context_lkg_slots (runtime_session_id, slot_key, lkg_json, captured_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (runtime_session_id, slot_key) DO UPDATE SET
           lkg_json = excluded.lkg_json, captured_at = excluded.captured_at`,
      )
      .run(slot.runtimeSessionId, slot.slotKey, slot.lkgJson, slot.capturedAt);
    if (result.changes === 0) {
      throw new Error(`context captureLkgSlot failed for ${slot.runtimeSessionId}/${slot.slotKey}`);
    }
  }

  getLkgSlot(runtimeSessionId: string, slotKey: string): LkgSlot | undefined {
    const row = this.db
      .prepare(
        "SELECT runtime_session_id, slot_key, lkg_json, captured_at FROM context_lkg_slots WHERE runtime_session_id = ? AND slot_key = ?",
      )
      .get(runtimeSessionId, slotKey) as
      | { runtime_session_id: string; slot_key: string; lkg_json: string; captured_at: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      runtimeSessionId: row.runtime_session_id,
      slotKey: row.slot_key,
      lkgJson: row.lkg_json,
      capturedAt: row.captured_at,
    };
  }

  /**
   * Invariant check used by migration/crash tests: a corrupt or newer DB must
   * refuse to open, while an empty DB initializes cleanly.
   */
  static checksumOf(sql: string): string {
    return createHash("sha256").update(sql, "utf8").digest("hex");
  }
}

/** Migration dir for a given context.db path (tests may pass a temp copy). */
function migrationsDirFor(contextDbPath: string): string {
  void contextDbPath;
  // The migration SQL files live beside the schema; resolve relative to this
  // source file so src/ and dist/ builds both work.
  return fileURLToPath(new URL("../db/migrations/context", import.meta.url));
}
