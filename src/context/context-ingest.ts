import {
  KIND_TO_SEMANTIC_SCHEMA_ID,
  SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
  computeContextMessageUnitContentHashV1,
  validateSemanticContentForSchema,
  type ContextIngestPort,
  type ContextMessageUnitV1,
  type JsonValue,
  type SemanticDerivationRefsV1,
  type UnitDispositionFilter,
} from "../contracts/context-v27.js";
import {
  computeContentTextHash,
  isCompanionEvent,
  isCompanionPayload,
  type CanonicalRuntimeEventV1,
  type RuntimeEventInput,
} from "../contracts/runtime-events.js";
import {
  ContextBoundsExceededError,
  type ContextStore,
  type UnitStoreRecord,
} from "./context-store.js";

/**
 * R2-P0 + v27–v29：ContextMessageUnitV1 的持久化端口（context.db，context_units
 * 表）。Entry/pairing 元数据（entryId/entrySeq/paired/companionEntryId/pairKey）
 * 不在 V1 DTO 上 —— 那是持久化层私有细节，通过 UnitStoreRecord（findBySourceEvent）
 * 或 insertUnit options.pairing / updateUnitPairingColumns 物理列更新暴露。
 */
export interface ContextUnitStorePort {
  hasUnitForEvent(eventId: string): boolean;
  insertUnit(
    unit: ContextMessageUnitV1,
    options?: {
      verifySessionBinding?: boolean;
      runtimeSessionId?: string;
      /** 中性 user 折叠：插入时原子携带的 companion 配对元数据。 */
      pairing?: { companionEntryId: string; pairKey: string; paired: boolean };
    },
  ): void;
  updateUnitPairing(
    runtimeSessionId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: JsonValue },
  ): void;
  listUnits(
    runtimeSessionId: string,
    options?: { afterContextSeq?: number; limit?: number; disposition?: UnitDispositionFilter },
  ): ContextMessageUnitV1[];
  /** 按源事件找单元（companion 邻接配对的幂等锚点），携带持久化元数据。 */
  findBySourceEvent(eventId: string): UnitStoreRecord | undefined;
  lastUnpairedInputSeq(runtimeSessionId: string): number | undefined;
  maxContextSeq(runtimeSessionId: string): number;
  /**
   * lineage-direct variants for the Recovery Reconciler（历史 Runtime Session
   * 无法按 session 解析 → 按 lineage 直查）。
   */
  maxContextSeqByLineage(lineageId: string): number;
  listUnitsByLineage(
    lineageId: string,
    options?: { afterContextSeq?: number; limit?: number; disposition?: UnitDispositionFilter },
  ): ContextMessageUnitV1[];
  updateUnitPairingByLineage(
    lineageId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: JsonValue },
  ): void;
  close(): void;
}

/**
 * Feature A (#110): stable contextUnitId prefix for a V1 kind. Keeps the
 * legacy id convention (input-/assistant-/tool_result-) so durable unit
 * identities are stable across the legacy→V1 migration.
 */
function unitIdPrefixForKind(kind: "user" | "assistant" | "tool_result"): string {
  switch (kind) {
    case "user":
      return "input";
    case "assistant":
      return "assistant";
    case "tool_result":
      return "tool_result";
  }
}

/** 提取 user payload 的原始文本（content 可为 string 或 text-part 数组）。 */
function extractUserText(payload: JsonValue): string {
  const record = payload as { content?: unknown };
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part !== null && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") {
            return text;
          }
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * 中性 user 折叠（Notion v27–v29 + Phase C 设计指导）：
 * - 语义内容以用户 payload 为准（原样作为 semanticContent；中性 payload 已由
 *   runtime adapter 解码为 canonical 语义内容，不是 Pi raw wire，无需占位）；
 * - companion 信息（pairKey/paired）写入持久化配对列（companion_entry_id /
 *   pair_key / paired），不进 semanticContent；
 * - 验证 basis：companion.contentHash（若提供）必须等于用户 payload 原始文本的
 *   sha256；缺失/不匹配 → paired=false（fail-conservative，绝不补造配对）。
 */
function foldUserPayload(
  userPayload: JsonValue,
  companion: { pairKey: string; contentHash?: string } | undefined,
): { semanticContent: JsonValue; paired: boolean; pairKey: string } {
  if (companion === undefined || companion.pairKey === "") {
    return { semanticContent: userPayload, paired: false, pairKey: "" };
  }
  const verified =
    companion.contentHash !== undefined &&
    computeContentTextHash(extractUserText(userPayload)) === companion.contentHash;
  return {
    semanticContent: userPayload,
    paired: verified,
    pairKey: companion.pairKey,
  };
}

/**
 * R2-P0：确定性、可重放的 Context ingest。从 runtime-event ledger 读取已提交
 * 事件，为缺失的 source_event_id 创建 ContextMessageUnitV1（context_seq 每
 * lineage 单调分配）；user+companion 折叠为中性配对（双事件模型：
 * 主 user 事件 + companionOf 指向主事件的 companion 事件；或主事件携带
 * `companion` 标记的单事件表达）。
 *
 * 与 v27–v29 的权威关系：
 *  - RuntimeEvent 与 ContextMessageUnit 在同一个 SQLite 事务中按同一
 *    contextSeq 原子提交（ingestRuntimeEvent）；
 *  - payload 是符合语义 schema 的中性 JsonValue（不是 Pi 消息）；Context ingest
 *    不解析任何 Pi 消息形状，Pi 解码/companion 拆分全部在 runtime adapter 完成；
 *  - 幂等：idempotencyKey/eventId exactly-once（重复 ingest 返回既有对）。
 */
export class ContextIngest implements ContextIngestPort {
  constructor(
    private readonly store: ContextStore,
    /** identity-level lineage id（one per data root）。 */
    private readonly lineageId: string,
    /**
     * 恢复模式（Recovery Reconciler）：true 时所有单元写入按 lineage 直查
     * （历史 Runtime Session 无法按 session 解析）。恢复模式 NEVER 把旧
     * Session 重新变回 current。
     */
    private readonly recovery = false,
  ) {}

  private resolveLineage(input: RuntimeEventInput): string {
    if (this.recovery) {
      return this.lineageId;
    }
    if (input.runtimeSessionId === undefined) {
      throw new Error(
        "context ingest: input carries no runtimeSessionId for lineage resolution (fail closed)",
      );
    }
    return this.store.resolveLineageId(input.runtimeSessionId);
  }

  private resolveLineageForSession(runtimeSessionId: string): string {
    if (this.recovery) {
      return this.lineageId;
    }
    return this.store.resolveLineageId(runtimeSessionId);
  }

  /**
   * 语义校验（fail-closed，无 escape hatch）：
   *  - companion 事件：payload 必须是 CompanionPayloadV1（不按 kind→semantic
   *    schema 校验 —— companion 的 payload 是中性元数据，不是语义内容）；
   *  - 其余事件：payload 必须通过对应语义 schema 校验。
   */
  private validateInput(input: RuntimeEventInput): void {
    if (isCompanionEvent(input)) {
      if (!isCompanionPayload(input.payload)) {
        throw new Error(
          `context ingest: companion event ${input.eventId} payload must be CompanionPayloadV1 ` +
            "(type 'iris_input_meta' + pairKey) (fail closed)",
        );
      }
      return;
    }
    const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[input.kind];
    if (semanticSchemaId === undefined) {
      throw new Error(
        `context ingest: unknown RuntimeEventKind ${JSON.stringify(input.kind)} (fail closed)`,
      );
    }
    const error = validateSemanticContentForSchema(semanticSchemaId, input.payload);
    if (error !== null) {
      throw new Error(
        `context ingest: semantic content for kind ${input.kind} failed validation: ${error} (fail closed)`,
      );
    }
  }

  /**
   * 原子 ingest：RuntimeEventInput → CanonicalRuntimeEventV1 + ContextMessageUnitV1
   * 同一 SQLite 事务、同一 contextSeq。exactly-once：已提交 eventId 直接返回
   * 既有对（不重复分配 contextSeq、不重复写单元）。
   *
   * companion 事件（isCompanionEvent）不建自身单元：其 canonical event 行原子
   * 落 ledger，同时把配对信息并入主 user 单元（同一事务）。
   */
  ingestRuntimeEvent(input: RuntimeEventInput): {
    event: CanonicalRuntimeEventV1;
    unit: ContextMessageUnitV1 | null;
  } {
    this.validateInput(input);
    const lineageId = this.resolveLineage(input);
    const existing = this.store.findRuntimeEventByEventId(input.eventId);
    if (existing !== undefined) {
      return { event: existing, unit: this.store.findBySourceEvent(input.eventId)?.unit ?? null };
    }
    const seq = this.store.nextContextSeqForLineage(lineageId);
    const sessionId = input.runtimeSessionId;
    this.store.beginAtomicIngest();
    try {
      const event = this.store.ingestRuntimeEvent(input, {
        contextLineageId: lineageId,
        contextSeq: seq,
      });
      if (isCompanionEvent(input)) {
        this.mergeCompanion(input, lineageId);
        this.store.commitAtomicIngest();
        return { event, unit: null };
      }
      const built = this.buildUnit(input, seq, lineageId);
      if (built !== null && !this.store.hasUnitForEvent(input.eventId)) {
        this.store.insertUnit(built.unit, {
          ...(this.recovery
            ? { verifySessionBinding: false }
            : sessionId !== undefined
              ? { runtimeSessionId: sessionId }
              : {}),
          ...(built.pairing !== undefined ? { pairing: built.pairing } : {}),
        });
      }
      this.store.commitAtomicIngest();
      return { event, unit: built?.unit ?? null };
    } catch (error) {
      this.store.rollbackAtomicIngest();
      // R2-P3：硬 cap 失败必须持久化 lineage 紧急态（原子事务内 insertUnit 的
      // emergency 写入会被 rollback 撤销，这里在事务外重放，保证 fail-closed
      // 信号在崩溃/重启后仍可读）。
      if (error instanceof ContextBoundsExceededError && sessionId !== undefined) {
        try {
          this.store.setEmergencyState(sessionId, "emergency_fail_closed", error.message);
        } catch {
          // 紧急态标记失败不得掩盖原始失败。
        }
      }
      throw error;
    }
  }

  /**
   * 把 companion 事件的配对信息并入主 user 单元（幂等、fail-conservative）：
   * - 主事件缺失 / 主单元非 user / 主单元已配对 / companion payload 形状非法
   *   → 不合并（绝不与错误单元错配，也绝不重复配对）；
   * - 合并只写配对列（companion_entry_id/pair_key/paired），semanticContent
   *   以主单元原样为准。
   */
  private mergeCompanion(input: RuntimeEventInput, lineageId: string): void {
    const mainEventId = input.companionOf;
    if (mainEventId === undefined) {
      return; // 孤立 companion（无 companionOf）：无法定位主单元，fail-conservative
    }
    const mainRecord = this.store.findBySourceEvent(mainEventId);
    if (mainRecord?.unit.kind !== "user") {
      return; // 主单元缺失/非 user：不合并
    }
    if (mainRecord.persistenceMeta.paired) {
      return; // 已配对：幂等跳过，绝不重配对
    }
    if (!isCompanionPayload(input.payload)) {
      return; // payload 形状非法：fail-conservative（validateInput 已保证，双保险）
    }
    const folded = foldUserPayload(mainRecord.unit.semanticContent, input.payload);
    this.store.updateUnitPairingColumns(lineageId, mainRecord.unit.contextSeq, {
      companionEntryId: input.eventId,
      pairKey: folded.pairKey,
      paired: folded.paired,
    });
  }

  /**
   * 事件→单元映射（fail-closed）：user/assistant/tool_result 建语义单元；
   * companion 事件与 tool_call/body_event/operational（非 companion）只落
   * canonical event ledger（物理 context_units 的 unit_type CHECK 只支持
   * input/assistant/tool_result，不猜测映射到错误物理行）。
   */
  private buildUnit(
    input: RuntimeEventInput,
    seq: number,
    lineageId: string,
  ): {
    unit: ContextMessageUnitV1;
    pairing: { companionEntryId: string; pairKey: string; paired: boolean } | undefined;
  } | null {
    switch (input.kind) {
      case "user": {
        // 语义内容以用户 payload 为准；pairing 来自主事件 `companion` 标记
        // （单事件表达）或稍后由 companion 事件（companionOf）合并。
        const folded = foldUserPayload(input.payload, input.companion);
        return {
          unit: this.buildUnitBase(input, seq, lineageId, "user", folded.semanticContent),
          pairing:
            folded.pairKey === ""
              ? undefined
              : {
                  companionEntryId: "",
                  pairKey: folded.pairKey,
                  paired: folded.paired,
                },
        };
      }
      case "assistant":
      case "tool_result":
        return {
          unit: this.buildUnitBase(input, seq, lineageId, input.kind, input.payload),
          pairing: undefined,
        };
      case "tool_call":
      case "body_event":
      case "operational":
        return null;
      default:
        throw new Error(
          `context ingest: unhandled kind ${JSON.stringify(input.kind)} (fail closed)`,
        );
    }
  }

  /**
   * 构建 canonical ContextMessageUnitV1。
   *  - kind → semanticSchemaId（KIND_TO_SEMANTIC_SCHEMA_ID，机器权威）；
   *  - contentHash = computeContextMessageUnitContentHashV1（唯一版本化 basis：
   *    semanticContent + kind + historianDisposition + derivationRefs +
   *    semanticSchemaId；绝不是 raw event hash / provider wire）；
   *  - lifecycleState = committed；rawArchiveRef 来自输入 attribution。
   */
  private buildUnitBase(
    input: RuntimeEventInput,
    seq: number,
    lineageId: string,
    kind: "user" | "assistant" | "tool_result",
    semanticContent: JsonValue,
  ): ContextMessageUnitV1 {
    const semanticSchemaId = KIND_TO_SEMANTIC_SCHEMA_ID[kind];
    const derivationRefs: SemanticDerivationRefsV1 = {
      schemaId: SEMANTIC_DERIVATION_REFS_V1_SCHEMA_ID,
      memoryRefs: [...(input.derivationRefs?.memoryRefs ?? [])],
      compartmentIds: [...(input.derivationRefs?.compartmentIds ?? [])],
      ...(input.derivationRefs?.workSnapshotVersion !== undefined
        ? { workSnapshotVersion: input.derivationRefs.workSnapshotVersion }
        : {}),
      sourceContextMessageUnitIds: [...(input.derivationRefs?.sourceContextMessageUnitIds ?? [])],
    };
    const unit: ContextMessageUnitV1 = {
      schemaId: "iris.context_message_unit.v1",
      contextUnitId: `${unitIdPrefixForKind(kind)}-${input.eventId}`,
      contextLineageId: lineageId,
      contextSeq: seq,
      runtimeEventId: input.eventId,
      kind,
      semanticSchemaId,
      semanticContent,
      historianDisposition: "include",
      derivationRefs,
      contentHash: computeContextMessageUnitContentHashV1({
        semanticSchemaId,
        kind,
        historianDisposition: "include",
        derivationRefs,
        semanticContent,
      }),
      lifecycleState: "committed",
      ...(input.rawArchiveRef !== undefined ? { rawArchiveRef: input.rawArchiveRef } : {}),
      createdAt: input.occurredAt,
    };
    return unit;
  }

  /**
   * 重放/恢复对账：读取已提交事件，为缺失单元创建单元（原子提交后本应无
   * 缺失；作为安全网与崩溃窗口恢复使用）。companion 事件的重放：在主单元
   * 存在后重新合并配对（幂等）。limit 限制单次处理的事件数。
   */
  ensureUnitsUpTo(
    runtimeSessionId: string,
    options: { limit?: number } = {},
  ): ContextMessageUnitV1[] {
    const lineageId = this.resolveLineageForSession(runtimeSessionId);
    const events = this.store.listStoredEventsByLineage(lineageId, options);
    for (const event of events) {
      const input = this.store.reconstructRuntimeEventInput(event);
      if (isCompanionEvent(input)) {
        if (input.companionOf !== undefined) {
          this.mergeCompanion(input, lineageId); // 幂等；主单元缺失则跳过
        }
        continue;
      }
      if (this.store.hasUnitForEvent(event.runtimeEventId)) {
        continue; // exactly-once：已建单元的事件跳过
      }
      const built = this.buildUnit(input, event.contextSeq, lineageId);
      if (built === null) {
        continue; // ledger-only 事件（tool_call/body_event/operational）
      }
      this.store.insertUnit(built.unit, {
        ...(this.recovery ? { verifySessionBinding: false } : { runtimeSessionId }),
        ...(built.pairing !== undefined ? { pairing: built.pairing } : {}),
      });
    }
    if (this.recovery) {
      return this.store.listUnitsByLineage(this.lineageId);
    }
    return this.store.listUnits(runtimeSessionId);
  }

  listUnits(
    runtimeSessionId: string,
    options: {
      afterContextSeq?: number;
      limit?: number;
      disposition?: UnitDispositionFilter;
    } = {},
  ): ContextMessageUnitV1[] {
    return this.store.listUnits(runtimeSessionId, options);
  }

  close(): void {
    this.store.close();
  }
}
