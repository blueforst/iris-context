/**
 * Historian publication + 权威 outbox（Phase D，provider-neutral）。
 *
 * v29：Historian core 只产出 provider-neutral `MemoryObservation[]` + generic
 * `MemoryPublication`；不生成 provider-engine Episode/Entity/Fact/Edge/group/
 * projectionVersion/targetGroupId。与 iris_memory 0.3.0 的 provider-shaped
 * wire 映射发生在 Memory Service Adapter（iris_agent / cordis adapter 侧），
 * 不进入 iris-context core。
 *
 * ONE atomic historian.db 事务提交：
 *   safe CompartmentRevision + AttributionManifest
 *   + provider-neutral MemoryObservation[] → MemoryPublication
 *   + lineage cursor 推进
 *   + HistorianPublication + 权威 publication_outbox 行
 *   → 产出 HistorianCommitReceiptV1（Context 侧幂等 ACK）。
 *
 * 保留的机制：
 *  - publicationSequence 只在最终 commit 事务内按 MAX+1 分配（绝不预分配）；
 *  - 确定性 publicationId / outputHash / rangeHash(contextSeq)；
 *  - outbox 状态机 pending → delivering → delivered / retry_wait / quarantined；
 *    claim lease 过期回收；只有绑定 receipt 才授权 delivered；
 *  - HistorianProvenanceError fail-closed（无 Context 批 basis 绝不发布）。
 */

import { createHash } from "node:crypto";

import type { ContextMessageUnitV1 } from "../contracts/context-v27.js";
import type { HistorianBatchV1, HistorianCommitReceiptV1 } from "../contracts/historian.js";
import { newReceiptId } from "../contracts/historian.js";
import type {
  EvidenceBasisRefV1,
  MemoryCompartmentRevision,
  MemoryObservationV1,
  MemoryPublicationV1,
  ObservationAttributionClass,
  ObservationSourceTrust,
} from "../contracts/memory-publication.js";
import {
  authorMemoryObservation,
  canonicalJsonStringify,
  computePublicationOutputHash,
  memoryRangeHash,
  publicationIdOf,
} from "../contracts/memory-publication.js";
import { renderUnitProviderText } from "./historian-compartment.js";
import type { BuiltCompartment } from "./historian-compartment.js";
import type { HistorianSemanticAdapterRegistry } from "./semantic-adapter-registry.js";
import type { HistorianStore } from "./historian-store.js";

export type OutboxState = "pending" | "delivering" | "retry_wait" | "delivered" | "quarantined";

/** 一条已提交的 HistorianPublication（historian.db `publications` 一行）。 */
export interface PublicationRecord {
  publicationSequence: number;
  publicationId: string;
  lineageId: string;
  /** attribution only。 */
  runtimeSessionId: string;
  batchId: string;
  claimId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  processingProfileId: string;
  compartmentIds: string[];
  /** MemoryObservationV1[]（provider-neutral）。 */
  observationsJson: string;
  /** MemoryCompartmentRevision[]。 */
  compartmentRevisionsJson: string;
  outputHash: string;
  previousPublicationSequence: number | null;
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
  /** 完整 provider-neutral MemoryPublicationV1 envelope（投递载荷）。 */
  payloadJson: string | null;
  state: OutboxState;
  attemptCount: number;
  lastErrorCode: string | null;
  claimLeasedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * provider-neutral Memory delivery receipt（由 Memory Service Adapter 返回；
 * 本 core 只按绑定身份校验，不解释 provider wire）。
 */
export interface MemoryDeliveryReceipt {
  receiptId: string;
  publicationId: string;
  canonicalPayloadHash: string;
  contractVersion: string;
  /** duplicate-replay：同一 publicationId 的幂等重放 receipt。 */
  duplicateReplay?: boolean;
  originalPublicationId?: string;
}

export interface PublicationServiceOptions {
  store: HistorianStore;
  /** semantic adapter 注册表（frozen processing profile 的来源；可选）。 */
  registry?: HistorianSemanticAdapterRegistry;
  nowMs?: () => number;
  /** Router claim lease TTL (ms)。默认 60s。 */
  claimLeaseMs?: number;
}

/**
 * iris_agent#45: typed fail-closed error —— 没有已提交 Context 批 basis 的
 * publication 绝不落盘（在写任何行之前抛出，整个事务回滚）。
 */
export class HistorianProvenanceError extends Error {
  readonly lineageId: string;

  constructor(lineageId: string, message: string) {
    super(`historian provenance (fail closed): ${message} [lineage ${lineageId}]`);
    this.name = "HistorianProvenanceError";
    this.lineageId = lineageId;
  }
}

// ---------------------------------------------------------------------------
// Provider-neutral observation authoring（替代旧 partitionEpisodeSources）
// ---------------------------------------------------------------------------

/** unit kind → provider-neutral semantic metadata。 */
function unitSemanticMetadata(unit: ContextMessageUnitV1): {
  semanticKind: string;
  attributionClass: ObservationAttributionClass;
  sourceTrust: ObservationSourceTrust;
} {
  switch (unit.kind) {
    case "user":
      return { semanticKind: "dialogue", attributionClass: "user", sourceTrust: "observed" };
    case "assistant":
      return {
        semanticKind: "reasoning",
        attributionClass: "iris_decision",
        sourceTrust: "generated",
      };
    case "tool_call":
      return {
        semanticKind: "tool_call",
        attributionClass: "iris_decision",
        sourceTrust: "generated",
      };
    case "tool_result":
      return {
        semanticKind: "tool_result",
        attributionClass: "tool_observation",
        sourceTrust: "verified",
      };
    case "body_event":
      return {
        semanticKind: "body_event",
        attributionClass: "external_document",
        sourceTrust: "observed",
      };
    case "operational":
      return {
        semanticKind: "system_event",
        attributionClass: "external_document",
        sourceTrust: "verified",
      };
  }
}

export interface AuthorObservationsInput {
  lineageId: string;
  batch: HistorianBatchV1;
  /** 本批 evidence basis（anti-echo 已过滤；只含 include 且非 derived-only）。 */
  evidenceBasis: EvidenceBasisRefV1[];
  /** 本批 derivedOnly 标记。 */
  derivedOnly: boolean;
  now: string;
  /** 注册表（可选）：解释 annotation 的 Cordis seam（Phase F）。 */
  registry?: HistorianSemanticAdapterRegistry;
}

export interface AuthoredPublication {
  observations: MemoryObservationV1[];
  memoryRefs: string[];
}

/**
 * Author provider-neutral MemoryObservations。确定性：同一批单元 + 同一
 * basis → 同一 observations/identity/hash。绝不包含 provider-engine 形状字段。
 */
export function authorMemoryObservations(input: AuthorObservationsInput): AuthoredPublication {
  const { lineageId, batch, evidenceBasis, derivedOnly, now } = input;
  const basisByUnitId = new Map<string, EvidenceBasisRefV1>();
  for (const ref of evidenceBasis) {
    basisByUnitId.set(ref.contextUnitId, ref);
  }
  const basisIds = new Set(evidenceBasis.map((ref) => ref.contextUnitId));
  const memoryRefs = [
    ...new Set(evidenceBasis.flatMap((ref) => ref.derivationRefs?.memoryRefs ?? [])),
  ];

  // 按语义角色分组连续单元 → 每条 partition 一条 observation。
  const partitions: Array<{
    units: ContextMessageUnitV1[];
    meta: ReturnType<typeof unitSemanticMetadata>;
  }> = [];
  for (const unit of batch.units) {
    // v29：`exclude` 单元不进入模型分析正文，observation statement 只基于
    // include/reference_only 单元（cursor 仍按全窗口推进）。
    if (unit.historianDisposition === "exclude") {
      continue;
    }
    const meta = unitSemanticMetadata(unit);
    const lastPartition = partitions[partitions.length - 1];
    if (lastPartition?.meta.semanticKind === meta.semanticKind) {
      lastPartition.units.push(unit);
    } else {
      partitions.push({ units: [unit], meta });
    }
  }

  const observations: MemoryObservationV1[] = [];
  for (const partition of partitions) {
    const partUnits = partition.units;
    const partFromSeq = partUnits[0]?.contextSeq ?? batch.fromContextSeq;
    const partToSeq = partUnits[partUnits.length - 1]?.contextSeq ?? batch.throughContextSeq;
    const partRangeHash = memoryRangeHash({
      contextLineageId: lineageId,
      fromContextSeq: partFromSeq,
      throughContextSeq: partToSeq,
      units: partUnits,
    });
    const statement = partUnits.map((unit) => renderUnitProviderText(unit)).join("\n");
    const partBasis = partUnits
      .filter((unit) => basisIds.has(unit.contextUnitId))
      .map((unit) => {
        const ref = basisByUnitId.get(unit.contextUnitId);
        return ref === undefined ? undefined : { ...ref };
      })
      .filter((ref): ref is EvidenceBasisRefV1 => ref !== undefined);
    const lastPartUnit = partUnits[partUnits.length - 1];
    const referenceTime = lastPartUnit !== undefined ? lastPartUnit.createdAt : now;
    const observation = authorMemoryObservation({
      contextLineageId: lineageId,
      fromContextSeq: partFromSeq,
      throughContextSeq: partToSeq,
      rangeHash: partRangeHash,
      semanticSchemaId: partition.meta.semanticKind,
      statement,
      semanticKind: partition.meta.semanticKind,
      attributionClass: partition.meta.attributionClass,
      sourceTrust: partition.meta.sourceTrust,
      referenceTime,
      evidenceBasis: partBasis,
      derivedOnly,
    });
    // Cordis seam（Phase F）：adapter 只解释自有 schema 的 observation；
    // annotation 是唯一效果，绝不修改 disposition/provenance/source basis。
    if (input.registry !== undefined) {
      const firstPartUnit = partUnits[0];
      if (firstPartUnit === undefined) {
        throw new HistorianProvenanceError(
          lineageId,
          "cannot invoke a semantic adapter for an empty partition",
        );
      }
      const annotation = input.registry.invokeInterpret({
        unit: firstPartUnit,
        observation,
      })?.annotation;
      if (annotation !== undefined) {
        const statementRecord = observation.statement;
        observation.statement = {
          text: statementRecord,
          annotation,
        } as ContextMessageUnitV1["semanticContent"];
      }
    }
    observations.push(observation);
  }

  return { observations, memoryRefs };
}

// ---------------------------------------------------------------------------
// PublicationService（事务内 commit + 权威 outbox）
// ---------------------------------------------------------------------------

export interface CommitBatchInput {
  batch: HistorianBatchV1;
  built: BuiltCompartment;
  /** batch claim 时冻结的 processing profile id。 */
  processingProfileId: string;
  /** The durable lineage cursor BEFORE this commit. */
  previousProcessedThroughContextSeq: number;
}

export class PublicationService {
  private readonly store: HistorianStore;
  private readonly nowMs: () => number;
  private readonly claimLeaseMs: number;
  private readonly registry: HistorianSemanticAdapterRegistry | undefined;

  constructor(options: PublicationServiceOptions) {
    this.store = options.store;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
    this.registry = options.registry;
  }

  /**
   * 在 runner 的 BEGIN..COMMIT 事务内调用：持久化 CompartmentRevision +
   * Manifest，分配下一个 publicationSequence（MAX+1，绝不预分配），插入
   * Publication + 权威 outbox 行，产出 HistorianCommitReceiptV1。
   * 任何失败 → 整个事务回滚（cursor 不推进、无 publication、无 outbox 行）。
   */
  commitBatch(input: CommitBatchInput): HistorianCommitReceiptV1 {
    const { batch, built, processingProfileId } = input;
    const lineageId = batch.contextLineageId;
    const now = new Date(this.nowMs()).toISOString();

    this.store.insertCompartment(built.compartment);
    this.store.insertAttributionManifest(built.attributionManifest);

    const publicationSequence = this.nextPublicationSequence();
    const publicationId = publicationIdOf(lineageId, publicationSequence);

    // hot-row reclaim 跟踪：每个 committed compartment 一行 release 状态
    // （四条件初始全空；ACK / bust / memory durable ack / shard verify 逐步填写）。
    this.store.upsertCompartmentRelease({
      compartmentId: built.compartment.compartmentId,
      runtimeSessionId: built.compartment.lineageId,
      compartmentSequence: built.compartment.compartmentSequence,
      startContextSeq: built.compartment.startContextSeq,
      endContextSeq: built.compartment.endContextSeq,
      publicationSequence,
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
    });

    const authored = authorMemoryObservations({
      lineageId,
      batch,
      evidenceBasis: built.evidenceBasis,
      derivedOnly: built.derivedOnly,
      now,
      ...(this.registry !== undefined ? { registry: this.registry } : {}),
    });
    const memoryRefs = authored.memoryRefs;
    const compartmentRevision: MemoryCompartmentRevision = {
      compartmentId: built.compartment.compartmentId,
      compartmentSequence: built.compartment.compartmentSequence,
      headContextSeq: batch.throughContextSeq,
      summary: built.compartment.content.slice(0, 4000),
      importance: built.compartment.importance,
      episodeType: built.compartment.episodeType,
      memoryRefs,
    };
    const envelopeBase = {
      schemaId: "iris.memory_publication.v1" as const,
      publicationId,
      publicationSequence,
      lineageId,
      contextRange: {
        contextLineageId: lineageId,
        fromContextSeq: batch.fromContextSeq,
        throughContextSeq: batch.throughContextSeq,
        rangeHash: batch.rangeHash,
      },
      observations: authored.observations,
      compartmentRevisions: [compartmentRevision],
      derivationSummary: { derivedOnly: built.derivedOnly, memoryRefs },
      publishedAt: now,
      processingProfileId,
    };
    const outputHash = computePublicationOutputHash(envelopeBase);
    const publication: MemoryPublicationV1 = { ...envelopeBase, outputHash };

    const previousPublicationSequence = this.previousPublicationSequence(lineageId);
    const record: PublicationRecord = {
      publicationSequence,
      publicationId,
      lineageId,
      runtimeSessionId: built.compartment.runtimeSessionId,
      batchId: batch.batchId,
      claimId: batch.claimId,
      fromContextSeq: batch.fromContextSeq,
      throughContextSeq: batch.throughContextSeq,
      rangeHash: batch.rangeHash,
      processingProfileId,
      compartmentIds: [built.compartment.compartmentId],
      observationsJson: JSON.stringify(authored.observations),
      compartmentRevisionsJson: JSON.stringify([compartmentRevision]),
      outputHash,
      previousPublicationSequence,
      state: "pending",
      attemptCount: 0,
      claimLeasedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertPublication(record);

    this.store.insertOutboxRow({
      publicationId,
      runtimeSessionId: built.compartment.runtimeSessionId,
      payloadHash: outputHash,
      payloadJson: JSON.stringify(publication),
      state: "pending",
      attemptCount: 0,
      lastErrorCode: null,
      claimLeasedUntil: null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      schemaId: "iris.historian_commit_receipt.v1",
      receiptId: newReceiptId(batch.batchId, batch.claimId),
      batchId: batch.batchId,
      claimId: batch.claimId,
      contextLineageId: lineageId,
      fromContextSeq: batch.fromContextSeq,
      throughContextSeq: batch.throughContextSeq,
      rangeHash: batch.rangeHash,
      compartmentIds: [built.compartment.compartmentId],
      publicationIds: [publicationId],
      outputHash,
      committedAt: now,
    };
  }

  /** publicationSequence = MAX(publication_sequence)+1 (in-transaction)。 */
  private nextPublicationSequence(): number {
    const row = this.store
      .raw()
      .prepare("SELECT MAX(publication_sequence) AS max_seq FROM publications")
      .get() as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  /** The previous publication sequence for the lineage (chain). */
  private previousPublicationSequence(lineageId: string): number | null {
    const row = this.store
      .raw()
      .prepare("SELECT MAX(publication_sequence) AS max_seq FROM publications WHERE lineage_id = ?")
      .get(lineageId) as { max_seq: number | null } | undefined;
    return row?.max_seq ?? null;
  }

  // ---- 权威 outbox 状态机 ------------------------------------------------

  /**
   * Claim 一批未投递的 outbox 行（pending/retry_wait + 过期 lease，或
   * delivering + 过期 lease = crash 的 claim）。lease 使投递崩溃可恢复：
   * 投递中途死掉的 claim 在其 lease 过期后被重新认领。
   */
  claimBatch(input: { batchSize: number }): OutboxRow[] {
    const now = this.nowMs();
    const rows = this.store
      .raw()
      .prepare(
        "SELECT outbox_sequence, publication_id, runtime_session_id, payload_hash, payload_json, state, " +
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
      payload_json: string | null;
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
      payloadJson: row.payload_json,
      state: "delivering",
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      claimLeasedUntil: leasedUntil,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * delivered 只能由**验证过绑定身份**的 Memory receipt 授权
   * （publicationId + canonicalPayloadHash + contractVersion 全部匹配）。
   * 持久化完整绑定（不只是 hash），供 reclaim 授权与审计使用。
   */
  markDelivered(input: { publicationId: string; receipt: MemoryDeliveryReceipt }): void {
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
        `UPDATE publications SET
           state = 'delivered', delivered_at = ?, delivered_receipt_hash = ?,
           delivered_receipt_id = ?, delivered_receipt_schema_version = ?,
           delivered_receipt_publication_id = ?,
           delivered_canonical_payload_hash = ?,
           delivered_contract_version = ?,
           delivered_duplicate_replay = ?,
           updated_at = ?
         WHERE publication_id = ?`,
      )
      .run(
        now,
        input.receipt.duplicateReplay === true
          ? `dup:${input.receipt.originalPublicationId ?? ""}`
          : input.receipt.receiptId,
        input.receipt.receiptId,
        "memory-delivery-receipt-v1",
        input.receipt.duplicateReplay === true
          ? (input.receipt.originalPublicationId ?? input.receipt.publicationId)
          : input.receipt.publicationId,
        input.receipt.canonicalPayloadHash,
        input.receipt.contractVersion,
        input.receipt.duplicateReplay === true ? 1 : 0,
        now,
        input.publicationId,
      );
  }

  /**
   * 标记一次已 claim 的投递失败（retry_wait 直到 attempts 用尽，然后
   * quarantined）。retry_wait 必须携带未来退避 lease（now + exponential
   * backoff(attempt)），避免无退避热循环；quarantined 不可认领。
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

/** canonical JSON（供测试与审计使用）。 */
export function canonicalJson(value: unknown): string {
  return canonicalJsonStringify(value as import("../contracts/context-v27.js").JsonValue);
}

/** Deterministic sha256 of a canonical JSON payload. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
