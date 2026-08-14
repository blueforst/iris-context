/**
 * Provider-neutral Memory Observation / Publication authoring 契约（Phase D）。
 *
 * 权威来源：
 *  - Notion v29 Historian：Historian core 只产出 provider-neutral
 *    `MemoryObservation[]` + generic `MemoryPublication`；不生成
 *    provider-engine Episode/Entity/Fact/Edge/group/projectionVersion 形状；
 *  - Notion [Long-Term Memory Service & Plugin Boundary]：与 iris_memory
 *    0.3.0 的 provider-shaped wire 映射发生在 Memory Service Adapter
 *    （iris_agent / cordis adapter 侧），不进入 iris-context core。
 *
 * 本文件是 iris-context 自有的 generic authoring 权威（schemaId 版本化）。
 * 字段级 schema 中央 registry 未冻结前，本形状保证可被非 provider-engine
 * 消费（fixture 证明，见 test/historian-provider-neutral.test.ts）。
 *
 * 硬约束：无 provider SDK / 无 provider graph store / 无 provider-shaped DTO 作为 core DTO。
 */

import { createHash } from "node:crypto";

import type { JsonValue } from "./context-v27.js";

/** 反回显分类（anti-echo 输出为 provider-neutral observation authoring）。 */
export type ObservationAttributionClass =
  "user" | "external_document" | "tool_observation" | "iris_decision";

export type ObservationSourceTrust = "observed" | "verified" | "generated";

/**
 * 新 MemoryObservation 的 source basis 引用（v29 权威形状，含
 * contextLineageId / rawArchiveRef；disposition 不含 "retired"）。
 * 只有 historianDisposition=include 且非 derived-only 的单元可以成为 basis。
 */
export interface EvidenceBasisRefV1 {
  schemaId: "iris.evidence_basis_ref.v1";
  contextLineageId: string;
  contextUnitId: string;
  contextSeq: number;
  runtimeEventId: string;
  contentHash: string;
  historianDisposition: "include" | "reference_only" | "exclude";
  /** 派生引用（anti-echo 审计面；derived-only 单元不得进入 basis）。 */
  derivationRefs?: import("./context-v27.js").SemanticDerivationRefsV1;
  /** 原始 archive 引用（values-only；原文由 raw archive/blob 保留）。 */
  rawArchiveRef?: import("./context-v27.js").RawArchiveRefV1;
}

/**
 * provider-neutral MemoryObservationV1：一条可被任意 Memory engine 消费的
 * 记忆观察。statement 为中性语义内容（文本或结构化 JsonValue）；语义种类由
 * semanticSchemaId / semanticKind 表达；derivedOnly=true 表示该 observation
 * 只是复述既有记忆（不产生新的"事实"），由 anti-echo 标记。
 */
export interface MemoryObservationV1 {
  schemaId: "iris.memory_observation.v1";
  observationId: string;
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  semanticSchemaId: string;
  /** 中性语义陈述（文本或结构化 JsonValue；与 ContextMessageUnitV1.semanticContent 同源）。 */
  statement: JsonValue;
  semanticKind: string;
  attributionClass: ObservationAttributionClass;
  sourceTrust: ObservationSourceTrust;
  referenceTime: string;
  evidenceBasis: EvidenceBasisRefV1[];
  /** 反回显：true = 仅复述既有记忆，不得作为新"事实"来源。 */
  derivedOnly: boolean;
}

/** Context 范围（闭区间 [fromContextSeq .. throughContextSeq] + 确定性 range hash）。 */
export interface MemoryContextRange {
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
}

/** 一条 lineage-scoped Compartment 修订（回流 Context P3 的 VALUE）。 */
export interface MemoryCompartmentRevision {
  compartmentId: string;
  compartmentSequence: number;
  headContextSeq: number;
  summary: string;
  importance: string;
  episodeType: string;
  memoryRefs: string[];
}

/** 派生摘要（anti-echo 审计面）。 */
export interface MemoryDerivationSummary {
  derivedOnly: boolean;
  memoryRefs: string[];
}

/**
 * provider-neutral MemoryPublicationV1：权威 outbox/archive 的完整载荷。
 * 不包含任何 provider-engine 字段（无 episode/entity/fact/edge/group/projectionVersion/
 * targetGroupId）。
 */
export interface MemoryPublicationV1 {
  schemaId: "iris.memory_publication.v1";
  publicationId: string;
  publicationSequence: number;
  lineageId: string;
  contextRange: MemoryContextRange;
  observations: MemoryObservationV1[];
  compartmentRevisions: MemoryCompartmentRevision[];
  derivationSummary: MemoryDerivationSummary;
  outputHash: string;
  publishedAt: string;
  /** batch claim 时冻结的 processing profile（semantic adapter 版本集 hash）。 */
  processingProfileId: string;
}

// ---------------------------------------------------------------------------
// 确定性身份 / 哈希（纯函数）
// ---------------------------------------------------------------------------

/** 确定性 RFC-4122 UUID（sha1 namespace || name，version 5 + variant 10）。 */
export function deterministicUuid(name: string): string {
  const NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace
  const nsBytes = [...Buffer.from(NAMESPACE.replaceAll("-", ""), "hex")];
  const nameBytes = [...Buffer.from(name, "utf8")];
  const digest = createHash("sha1")
    .update(Buffer.from([...nsBytes, ...nameBytes]))
    .digest();
  const bytes = Array.from(digest.subarray(0, 16));
  const b6 = bytes[6];
  const b8 = bytes[8];
  if (b6 === undefined || b8 === undefined) {
    throw new Error("deterministicUuid: digest too short");
  }
  bytes[6] = (b6 & 0x0f) | 0x50; // version 5
  bytes[8] = (b8 & 0x3f) | 0x80; // variant 10
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 确定性 range hash（contextSeq 坐标）：sha256 over (contextLineageId,
 * 端点, ordered units 的 contextSeq:contextUnitId:contentHash)。同一窗口 +
 * 同一单元序列 → 同一 hash（跨 crash/restart 可重放）。
 */
export function memoryRangeHash(input: {
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  units: ReadonlyArray<
    Pick<import("./historian.js").HistorianBatchUnit, "contextSeq"> & {
      unit: Pick<import("./context-unit.js").ContextUnit, "unitId" | "contentHash">;
    }
  >;
}): string {
  const body = input.units
    .map((unit) => `${unit.contextSeq}:${unit.unit.unitId}:${unit.unit.contentHash}`)
    .join("\n");
  return createHash("sha256")
    .update(
      `${input.contextLineageId}|${input.fromContextSeq}|${input.throughContextSeq}|${body}`,
      "utf8",
    )
    .digest("hex");
}

/** 确定性 observationId（bind lineage + contextSeq 窗口 + semanticSchemaId）。 */
export function observationIdOf(input: {
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  semanticSchemaId: string;
}): string {
  return `obs-${input.contextLineageId}-${input.fromContextSeq}-${input.throughContextSeq}-${createHash(
    "sha256",
  )
    .update(input.semanticSchemaId, "utf8")
    .digest("hex")
    .slice(0, 12)}`;
}

/**
 * Author 一条 provider-neutral MemoryObservationV1（anti-echo 后的 authoring）。
 * 只描述语义内容与 basis，绝不包含 provider 形状字段。
 */
export function authorMemoryObservation(input: {
  contextLineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  rangeHash: string;
  semanticSchemaId: string;
  statement: JsonValue;
  semanticKind: string;
  attributionClass: ObservationAttributionClass;
  sourceTrust: ObservationSourceTrust;
  referenceTime: string;
  evidenceBasis: EvidenceBasisRefV1[];
  derivedOnly: boolean;
}): MemoryObservationV1 {
  return {
    schemaId: "iris.memory_observation.v1",
    observationId: observationIdOf({
      contextLineageId: input.contextLineageId,
      fromContextSeq: input.fromContextSeq,
      throughContextSeq: input.throughContextSeq,
      semanticSchemaId: input.semanticSchemaId,
    }),
    contextLineageId: input.contextLineageId,
    fromContextSeq: input.fromContextSeq,
    throughContextSeq: input.throughContextSeq,
    rangeHash: input.rangeHash,
    semanticSchemaId: input.semanticSchemaId,
    statement: input.statement,
    semanticKind: input.semanticKind,
    attributionClass: input.attributionClass,
    sourceTrust: input.sourceTrust,
    referenceTime: input.referenceTime,
    evidenceBasis: input.evidenceBasis.map((ref) => ({ ...ref })),
    derivedOnly: input.derivedOnly,
  };
}

/** 确定性 publicationId（绑定 lineage + publicationSequence；跨重启稳定）。 */
export function publicationIdOf(contextLineageId: string, publicationSequence: number): string {
  return deterministicUuid(`iris:memory-publication:${contextLineageId}:${publicationSequence}`);
}

/**
 * 输出 hash：canonical sha256 over 完整版本化载荷（outputHash 字段置空，
 * no-self-reference 规则）。任何 provenance/basis/statement 变化都会改变 hash。
 */
export function computePublicationOutputHash(
  envelopeBase: Omit<MemoryPublicationV1, "outputHash">,
): string {
  const canonical = canonicalJsonStringify({ ...envelopeBase, outputHash: "" });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** canonical JSON（键排序 + 紧凑序列化；确定性、无歧义；接受 unknown）。 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k] ?? null)}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}
