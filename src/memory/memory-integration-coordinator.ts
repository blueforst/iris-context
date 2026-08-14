/**
 * MemoryIntegrationCoordinator —— 唯一、thin/reconstructable 的 Memory Service
 * 集成边界（Phase E，P4 Recollection / BUST-only）。
 *
 * 权威来源：Notion v29 P4 Recollection / BUST-only Override + Long-Term
 * Memory Service & Plugin Boundary：
 *   - Context-owned Recall Intent → Memory Integration Coordinator →
 *     active Memory Service Adapter → provider-neutral RecollectionSnapshot
 *     → Context-owned validation/sanitization/dedupe/budget/ordering → P4
 *     ContextUnitV2 projection（P4RecollectionProjector，本模块不含投影）；
 *   - Identity scope 中 exactly one、thin/reconstructable；backend 为
 *     zero-or-one（zero-backend 合法 → P4 为空，Context/Historian 正常运行）；
 *   - backend 只返回 provider-neutral snapshot，绝不创建 ContextUnitV2；
 *     backend 的 revision/可用性变化只能产生 memory source invalidation →
 *     requestBust(...)，不能直接更新 P4；
 *   - provider 不可用时显式标记 unavailable（绝不伪装为"无记忆"）。
 *
 * 硬约束：无 Graphiti SDK / Neo4j / backend-private DTO 进入本模块。
 */

import { createHash } from "node:crypto";

/** Memory Service 状态（coordinator 规范化后的视图）。 */
export type MemoryServiceStatus = "disabled" | "ready" | "unavailable" | "error";

/** Context-owned Recall Intent：由 BUST 冻结的当前认知状态构建（bounded）。 */
export interface RecallIntent {
  schemaId: "iris.recall_intent.v1";
  contextLineageId: string;
  /** BUST 将发布的 generation id（绑定 recall 快照）。 */
  contextGenerationId: string;
  /** 冻结时刻（safe provider boundary）。 */
  frozenAt: string;
  /** bounded query/context 摘要（中性文本；不包含 provider wire）。 */
  querySummary: string;
  /** recall 预算（bounded；P4 projector 强制上限）。 */
  budget: { maxCandidates: number };
  /** 冻结的 P0–P3/P5 source snapshot hash（recall 上下文身份）。 */
  sourceSnapshotHash: string;
}

/** 中性 recall 候选（provider-neutral；非权威，只表达关联回忆证据）。 */
export interface RecollectionCandidate {
  /** backend-agnostic 稳定身份。 */
  recollectionId: string;
  /** 中性语义陈述（文本）。 */
  statement: string;
  sourceTrust: "observed" | "verified" | "generated";
  referenceTime?: string;
  provenanceRef?: string;
  /** 相关性分数（仅排序用；不是 authority/truth）。 */
  relevanceScore?: number;
}

/**
 * Memory Service Adapter 返回的原始 recall 结果（provider-neutral 数据快照）。
 * 接口层面保证：backend 只能返回 snapshot，不能创建 ContextUnitV2。
 */
export interface MemoryRecallResult {
  snapshotId?: string;
  revision?: string;
  status: "ready" | "unavailable" | "disabled";
  candidates: readonly RecollectionCandidate[];
  unavailableReason?: string;
  recalledAt?: string;
}

/**
 * Memory Service Adapter（zero-or-one；Cordis plugin 侧由 Phase F 接线）。
 * 只负责 service endpoint / transport / status / epoch / recall RPC 的
 * normalization；不拥有长期语义状态、不做 P4 projection、不建第二份 outbox。
 */
export interface MemoryServiceAdapter {
  readonly serviceId: string;
  /** backend dataset/service 身份（recall 可见性）。 */
  readonly epoch: string;
  /** recall-visible revision（变化 → memory source invalidation → requestBust）。 */
  readonly revision: string;
  status(): MemoryServiceStatus;
  recall(intent: RecallIntent): Promise<MemoryRecallResult>;
}

/**
 * Coordinator 规范化后的 canonical RecollectionSnapshot（P4 projector 消费）。
 * snapshotHash 是确定性 hash（覆盖 snapshotId/revision/status/candidates）；
 * 同一 snapshot 必须产生同一 hash（generation-scoped 内 P4 内容/顺序/hash
 * 固定）。status='disabled' → P4 空（zero-backend）；status='unavailable' →
 * 显式 unavailable marker（不伪装空）。
 */
export interface RecollectionSnapshot {
  schemaId: "iris.recollection_snapshot.v1";
  snapshotId: string;
  revision: string;
  status: "ready" | "unavailable" | "disabled";
  recalledAt: string;
  candidates: readonly RecollectionCandidate[];
  unavailableReason?: string;
  snapshotHash: string;
}

/** canonical JSON（键排序 + 紧凑序列化；确定性）。 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] ?? null)}`);
  return `{${pairs.join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 确定性 snapshotId 派生（adapter 未提供时）。 */
function deriveSnapshotId(intent: RecallIntent, status: string): string {
  return `recall-${status}-${sha256(intent.contextGenerationId + "|" + intent.sourceSnapshotHash).slice(0, 16)}`;
}

/**
 * Memory Integration Coordinator —— exactly one、thin/reconstructable。
 * 持有 MemoryServiceAdapter | undefined（zero-or-one）。
 */
export class MemoryIntegrationCoordinator {
  private adapter: MemoryServiceAdapter | undefined;
  private lastStatus: MemoryServiceStatus = "disabled";
  private lastError: string | undefined;

  constructor(options: { adapter?: MemoryServiceAdapter } = {}) {
    this.adapter = options.adapter;
  }

  mount(adapter: MemoryServiceAdapter): void {
    this.adapter = adapter;
    this.lastError = undefined;
  }

  unmount(): void {
    this.adapter = undefined;
    this.lastError = undefined;
  }

  getAdapter(): MemoryServiceAdapter | undefined {
    return this.adapter;
  }

  /** 是否已配置 backend（zero-or-one）。 */
  isConfigured(): boolean {
    return this.adapter !== undefined;
  }

  /** backend 状态（无 adapter → 'disabled'）。 */
  getStatus(): MemoryServiceStatus {
    if (this.adapter === undefined) {
      return "disabled";
    }
    try {
      this.lastStatus = this.adapter.status();
    } catch (error) {
      this.lastStatus = "error";
      this.lastError = `memory adapter ${this.adapter.serviceId} status() threw: ${String(
        error instanceof Error ? error.message : error,
      )}`;
    }
    return this.lastStatus;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * BUST-only recall：把 Context-owned RecallIntent 交给 active backend，并
   * 规范化为 provider-neutral RecollectionSnapshot。任何 backend 失败都显式
   * 标记 unavailable（绝不伪装为"无记忆"）；zero-backend → status='disabled'
   * （P4 空）。本方法是 P4 的唯一更新路径 —— Provider Renderer / invocation /
   * memory Tool 都禁止调用 recall。
   */
  async recall(intent: RecallIntent): Promise<RecollectionSnapshot> {
    const now = new Date().toISOString();
    if (this.adapter === undefined) {
      return this.normalize({ status: "disabled", candidates: [] }, intent, now);
    }
    let status: MemoryServiceStatus;
    try {
      status = this.adapter.status();
    } catch (error) {
      this.lastStatus = "error";
      this.lastError = `memory adapter ${this.adapter.serviceId} status() threw: ${String(
        error instanceof Error ? error.message : error,
      )}`;
      return this.normalize(
        {
          status: "unavailable",
          candidates: [],
          unavailableReason: `memory service status check failed: ${this.lastError}`,
        },
        intent,
        now,
      );
    }
    this.lastStatus = status;
    if (status !== "ready") {
      this.lastError = `memory service ${this.adapter.serviceId} not ready (status=${status})`;
      return this.normalize(
        {
          status: "unavailable",
          candidates: [],
          unavailableReason: `memory service not ready (status=${status})`,
        },
        intent,
        now,
      );
    }
    try {
      const result = await this.adapter.recall(intent);
      if (result.status !== "ready") {
        this.lastError = result.unavailableReason ?? "memory service returned unavailable";
        return this.normalize(
          {
            status: "unavailable",
            candidates: [],
            unavailableReason: result.unavailableReason ?? "memory service returned unavailable",
          },
          intent,
          now,
        );
      }
      return this.normalize(result, intent, now);
    } catch (error) {
      this.lastError = `memory recall failed: ${String(
        error instanceof Error ? error.message : error,
      )}`;
      return this.normalize(
        {
          status: "unavailable",
          candidates: [],
          unavailableReason: this.lastError,
        },
        intent,
        now,
      );
    }
  }

  /** 规范化 adapter 结果 → canonical RecollectionSnapshot（含确定性 hash）。 */
  private normalize(
    result: MemoryRecallResult,
    intent: RecallIntent,
    now: string,
  ): RecollectionSnapshot {
    const status = result.status;
    const snapshotId = result.snapshotId ?? deriveSnapshotId(intent, status);
    const revision = result.revision ?? (status === "disabled" ? "zero-backend" : "v0");
    const recalledAt = result.recalledAt ?? now;
    const base = {
      schemaId: "iris.recollection_snapshot.v1" as const,
      snapshotId,
      revision,
      status,
      recalledAt,
      candidates: [...result.candidates],
      ...(result.unavailableReason !== undefined
        ? { unavailableReason: result.unavailableReason }
        : {}),
    };
    const snapshotHash = sha256(canonicalJson(base));
    return { ...base, snapshotHash };
  }
}
