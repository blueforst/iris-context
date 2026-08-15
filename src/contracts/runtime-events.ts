/**
 * RuntimeEvent — runtime-neutral canonical event ingest contract (Notion v25–v29).
 *
 * Iris 当前认知链路的源是 canonical RuntimeEvent：ingress / provider / tool
 * runtime 产生 stable lifecycle events，Context 模块在同一个 SQLite 事务中把
 * RuntimeEvent 与对应 ContextMessageUnit 按同一 `contextSeq` 原子提交。
 *
 * 本契约是 runtime-neutral 的 committed input port：
 *   - 不依赖 Pi（无 AgentMessage / CustomMessage / PiSeamEvent / Session 形状）；
 *   - `payload: JsonValue` 是符合对应语义 schema 的中性语义内容
 *     （contracts/generated/validators.js 的 validateSemanticContent）；
 *   - `runtimeSessionId` 仅作 attribution（archive/provenance 与 recovery
 *     reconciliation）；正常去重与排序以稳定 `runtimeEventId` 与跨 Session
 *     单调的 `contextSeq` 为准；
 *   - `companion` 是 runtime adapter 解码 user+provenance companion 后提供的中性
 *     关联标记（pairKey + contentHash），Context ingest 据此折叠 user 单元；
 *   - `idempotencyKey` 在物理层 UNIQUE，保证 exactly-once。
 *
 * 权威字段定义只以 Notion [01 Canonical Schemas] 为准。
 */

import { createHash } from "node:crypto";

import type {
  JsonValue,
  RawArchiveRefV1,
  RuntimeEventKind,
  SemanticDerivationRefsV1,
} from "../../contracts/generated/types.js";
import { KIND_TO_SEMANTIC_SCHEMA_ID } from "../../contracts/generated/types.js";

export type { JsonValue, RawArchiveRefV1, RuntimeEventKind, SemanticDerivationRefsV1 };
export { KIND_TO_SEMANTIC_SCHEMA_ID };

// ---------------------------------------------------------------------------
// OriginEnvelope — provenance, NOT a permission token or partition key.
// ---------------------------------------------------------------------------

export type OriginPrincipalKind =
  "user" | "external_actor" | "environment" | "tool" | "model" | "system";

export type OriginAuthority = "user_request" | "notice_only" | "data_only" | "internal_control";

export type OriginTrust = "trusted" | "limited" | "untrusted";

/** Provenance envelope (Notion OriginEnvelopeV1). Field-level shape locked here. */
export interface OriginEnvelope {
  schemaId: "iris.origin_envelope.v1";
  channel: string;
  principalKind: OriginPrincipalKind;
  principalRef?: string;
  authority: OriginAuthority;
  trust: OriginTrust;
  provenanceRef?: string;
}

/** 保守默认：来源未知时使用 data_only + untrusted（标注 provenanceRef 为缺省）。 */
export const UNTRUSTED_DATA_ONLY_ORIGIN: OriginEnvelope = {
  schemaId: "iris.origin_envelope.v1",
  channel: "unknown",
  principalKind: "environment",
  authority: "data_only",
  trust: "untrusted",
};

// ---------------------------------------------------------------------------
// RuntimeEventInput — the runtime-neutral committed input.
// ---------------------------------------------------------------------------

/** Companion 关联标记：由 runtime adapter 解码 user + provenance companion 后提供。 */
export interface RuntimeEventCompanion {
  /** 配对标识（inputId + wire 的确定性绑定）。 */
  pairKey: string;
  /** companion 内容的 canonical content hash（Context ingest 用于验证折叠）。 */
  contentHash: string;
  /** 布局 hash（adapter 侧 Pi content-layout 校验的 attribution；ingest 不重算）。 */
  layoutHash?: string;
}

/**
 * 中性 companion payload（CompanionPayloadV1）：companion 事件（`companionOf`
 * 指向主事件）的 payload 形状。Context ingest 不再解析任何 Pi 消息形状；
 * Pi UserMessage + iris_input_meta CustomMessage 的拆分/解码全部在 runtime
 * adapter 完成，本形状是两者之间的中性契约。
 */
export interface CompanionPayloadV1 {
  type: "iris_input_meta";
  /** 配对标识（与主事件 `companion` 标记的 pairKey 同源）。 */
  pairKey: string;
  /** 主事件语义内容的 canonical content hash（验证 basis，可缺省 → 不可验证）。 */
  contentHash?: string;
  /** 布局 hash attribution（adapter 侧计算）。 */
  layoutHash?: string;
  /** 中性 origin（缺省由 ingest 保守处理）。 */
  origin?: OriginEnvelope;
}

/** 类型守卫：payload 是否为中性 companion 元数据形状（fail-closed 判定基础）。 */
export function isCompanionPayload(value: unknown): value is CompanionPayloadV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["type"] === "iris_input_meta" && typeof record["pairKey"] === "string";
}

/**
 * 中性 companion 判定：`companionOf !== undefined`（双事件模型）或
 * operational + iris_input_meta payload。companion 事件不建自身单元，
 * 配对信息并入主事件对应的 user 单元。
 */
export function isCompanionEvent(input: RuntimeEventInput): boolean {
  return (
    input.companionOf !== undefined ||
    (input.kind === "operational" && isCompanionPayload(input.payload))
  );
}

/**
 * 中性运行时事件输入。`payload` 是符合 `KIND_TO_SEMANTIC_SCHEMA_ID[kind]`
 * 指向的语义 schema 的 JsonValue 语义内容（不是 provider wire，不是 Pi 消息）。
 */
export interface RuntimeEventInput {
  /** 稳定 event identity（ingress/provider/tool runtime 预分配）。 */
  eventId: string;
  kind: RuntimeEventKind;
  /** 仅 attribution：archive/provenance 与 recovery reconciliation。 */
  runtimeSessionId?: string;
  /** 模型可见 role（user/assistant/tool_result/...）；attribution。 */
  role?: string;
  /** 中性语义内容（JsonValue），必须通过对应语义 schema 校验（fail closed）。 */
  payload: JsonValue;
  /**
   * 本事件是主事件 `companionOf` 的 companion（双事件模型）：不建自身单元，
   * 配对信息并入主 user 单元；payload 必须是 CompanionPayloadV1。
   */
  companionOf?: string;
  /**
   * user 输入的 companion 关联标记（单事件表达，由 runtime adapter 解码
   * Pi UserMessage + iris_input_meta 后直接附在主事件上）。
   */
  companion?: RuntimeEventCompanion;
  /** tool_execution attribution。 */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** 来源/provenance；缺省由 ingest 以 data_only+untrusted 保守默认（并标注）。 */
  origin?: OriginEnvelope;
  derivationRefs?: SemanticDerivationRefsV1;
  /** Pi Session 只作 raw archive：可选的原文归档 attribution。 */
  rawArchiveRef?: RawArchiveRefV1;
  occurredAt: string;
  /** exactly-once：物理层 UNIQUE；重复 ingest 返回既有事件。 */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// CanonicalRuntimeEventV1 — the committed event (Notion Canonical Schemas).
// ---------------------------------------------------------------------------

/** 已提交的 canonical 事件。与 ContextMessageUnit 同一 contextSeq 原子提交。 */
export interface CanonicalRuntimeEventV1 {
  schemaId: "iris.runtime_event.v1";
  runtimeEventId: string;
  contextLineageId: string;
  contextSeq: number;
  invocationId?: string;
  kind: RuntimeEventKind;
  origin: OriginEnvelope;
  payloadSchemaId: string;
  payload: JsonValue;
  payloadHash: string;
  rawArchiveRef?: RawArchiveRefV1;
  createdAt: string;
  committedAt: string;
}

// ---------------------------------------------------------------------------
// RuntimeEventIngestPort — narrow, versioned ingest contract.
// ---------------------------------------------------------------------------

/** 窄、版本化的 committed input port：RuntimeEvent exactly-once 提交与顺序读取。 */
export interface RuntimeEventIngestPort {
  /**
   * exactly-once 提交一个中性 RuntimeEventInput 为 CanonicalRuntimeEventV1。
   * contextSeq 在该 lineage 内单调分配。重复 idempotencyKey/eventId → 返回
   * 既有事件（不产生重复行）。
   */
  ingest(input: RuntimeEventInput): CanonicalRuntimeEventV1;
  /** 按 lineage 的 contextSeq 顺序读取已提交事件。 */
  listByLineage(
    contextLineageId: string,
    options?: { afterContextSeq?: number; limit?: number },
  ): CanonicalRuntimeEventV1[];
  /** 按 runtimeSessionId（attribution）读取已提交事件。 */
  listByRuntimeSession(
    runtimeSessionId: string,
    options?: { limit?: number },
  ): CanonicalRuntimeEventV1[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Hash / canonical helpers
// ---------------------------------------------------------------------------

/** Canonical JSON serialization (deterministic key order) — payload hash basis. */
export function canonicalJsonStringify(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const obj = value as Record<string, JsonValue>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k] ?? null)}`);
  return `{${pairs.join(",")}}`;
}

/** Canonical payload hash of a neutral semantic payload (sha256 over canonical JSON). */
export function computePayloadHash(payload: JsonValue): string {
  return createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
}

/** Canonical hash of a single text part (companion verification basis). */
export function computeContentTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
