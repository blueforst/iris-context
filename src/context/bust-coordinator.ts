/**
 * BustCoordinator —— Iris 唯一 canonical BUST coordinator（Phase E）。
 *
 * 权威来源：Notion v27–v29 Context Assembly（Canonical BUST）：
 *
 *   requestBust(reason, evidence)
 *   → coalesce pending 请求（有界；多个 invalidation 合并）
 *   → 下一安全 provider 边界（runBustIfPending）
 *   → 使当前 generation 失效（不再可被新请求使用）
 *   → 冻结权威 P0–P5 sources（P0–P2 来自 contributor seam；P3 读 committed
 *     Compartments；P4 经 Memory Integration Coordinator；P5 读 durable live
 *     units）
 *   → 用 buildContextGenerationV3 完整重建（唯一 materializer；current Context
 *     直接包含 ContextUnit[]）
 *   → validate（build 已内建 fail-closed）
 *   → 原子发布（内存中替换 current generation；发布对象带 generationId+hash）
 *   → 发布成功后调用 retirementPort.markRepresentedAndRetired（唯一推进
 *     represented/retired watermark 的点）
 *
 * 失败 fail-closed：不发布半 generation、不 fallback 旧 generation（旧
 * generation 一旦进入 BUST 就不被新请求使用）、不推进 watermark。无
 * LKG/previous-generation 持久化 —— 只保留 bounded 审计（lastRun）。
 *
 * 硬约束：无第二套 materializer / Plugin Manager / DI；P4 只在本路径更新；
 * 无 m0/m1/LKG/SOFT-HARD。
 */

import { createHash } from "node:crypto";

import { CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID } from "../contracts/context-v27.js";
import type { ContextRetirementPortV1 } from "../contracts/context-retirement.js";
import type {
  MemoryIntegrationCoordinator,
  RecallIntent,
} from "../memory/memory-integration-coordinator.js";
import type { CommittedCompartmentReadPort } from "./committed-compartment-read-port.js";
import type { ContextStore } from "./context-store.js";
import { projectCommittedCompartmentCandidate } from "./p3-compartment.js";
import { P4RecollectionProjector } from "./p4-recollection.js";
import { materializeContextUnit } from "./context-admission.js";
import type { ContextUnit } from "../contracts/context-unit.js";
import type { P0P1P2P3P4Unit } from "./generation-builder.js";
import { buildContextGenerationV3 } from "./generation-builder.js";
import type { ContextGenerationV3 } from "../../contracts/generated/types.js";

// ---------------------------------------------------------------------------
// BUST request / evidence（audit）
// ---------------------------------------------------------------------------

/** 唯一 BUST reason 枚举（reason 仅用于审计/诊断，不选择另一套刷新流程）。 */
export type BustReason =
  | "historian_compartment_committed"
  | "capability_catalog_changed"
  | "persona_changed"
  | "system_changed"
  | "memory_source_invalidation"
  | "source_invalidation"
  | "integrity_invariant_failure"
  | "operator_requested";

const BUST_REASONS: readonly BustReason[] = [
  "historian_compartment_committed",
  "capability_catalog_changed",
  "persona_changed",
  "system_changed",
  "memory_source_invalidation",
  "source_invalidation",
  "integrity_invariant_failure",
  "operator_requested",
];

/** 结构化审计证据（bounded）。 */
export interface BustEvidence {
  schemaId: "iris.bust_evidence.v1";
  detail?: string;
  sourceRefs?: readonly string[];
  receiptIds?: readonly string[];
}

export interface BustRequest {
  reason: BustReason;
  evidence: BustEvidence;
  requestedAt: string;
}

// ---------------------------------------------------------------------------
// P0–P2 source contribution seam
// ---------------------------------------------------------------------------

/**
 * P0–P2 权威 source 的 contribution seam。owner（Persona / Skill / System /
 * Capability 模块）只提供 frozen snapshot / identity / hash 与 invalidation；
 * 不允许直接 push/splice generation（Notion Composition）。BUST 时 coordinator
 * 调用 project() 冻结投影。允许零 contributor（P0–P2 空）。
 */
export interface ContextSourceContributor {
  readonly layer: "p0" | "p1" | "p2";
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceHash: string;
  /** 冻结并投影当前 authoritative source 为 pre-projected units。 */
  project(): readonly P0P1P2P3P4Unit[];
  /**
   * 可选 invalidation seam：sourceId 属于本 contributor 时返回 true。
   * 只发出 invalidation 信号（coordinator 据此 requestBust）；不直接触发
   * rebuild。
   */
  invalidate?(sourceId: string): boolean;
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface BustRunResult {
  /** 本次调用是否执行了 rebuild（有 pending 请求）。 */
  ran: boolean;
  /** 是否成功原子发布新 generation。 */
  published: boolean;
  /** 是否失败（fail-closed：未发布、watermark 未推进、旧 generation 不可用）。 */
  failed: boolean;
  /** 失败原因（audit）。 */
  error?: string;
  /** 发布成功后的 generation（失败时 null）。 */
  generation: ContextGenerationV3 | null;
  /** 本次 BUST 的 audit id。 */
  bustId?: string;
}

export interface BustCoordinatorOptions {
  contextLineageId: string;
  /** P0–P2 contributors（允许零个）。 */
  contributors?: readonly ContextSourceContributor[];
  /** P3：committed Compartments 窄读端口（values-only）。 */
  committedCompartments: CommittedCompartmentReadPort;
  /** P4：Memory Integration Coordinator（exactly one；zero-backend 合法）。 */
  memoryCoordinator: MemoryIntegrationCoordinator;
  /** P5 live units + represented/retired watermark 的权威 owner。 */
  contextStore: ContextStore;
  /** retirement 端口（markRepresentedAndRetired 只在此路径调用）。 */
  retirementPort: ContextRetirementPortV1;
  /** P4 projector（Context-owned；缺省新建）。 */
  p4Projector?: P4RecollectionProjector;
  /** P4 recall 预算上限（RecallIntent.budget.maxCandidates）。 */
  p4MaxCandidates?: number;
  /** pending 请求有界上限（合并后不超）。 */
  maxPendingRequests?: number;
  /** 每个 pending 请求的 evidence 有界上限（sourceRefs/receiptIds）。 */
  maxPendingEvidencePerRequest?: number;
  /** 时间注入（默认 new Date().toISOString()）。 */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// BustCoordinator
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_PENDING_EVIDENCE_PER_REQUEST = 32;
const DEFAULT_P4_MAX_CANDIDATES = 64;

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

export class BustCoordinator {
  private readonly contextLineageId: string;
  /** P0–P2 contributors（Phase F：可逆注册，registerContributor 增删）。 */
  private contributors: readonly ContextSourceContributor[];
  private readonly committedCompartments: CommittedCompartmentReadPort;
  private readonly memoryCoordinator: MemoryIntegrationCoordinator;
  private readonly contextStore: ContextStore;
  private readonly retirementPort: ContextRetirementPortV1;
  private readonly p4Projector: P4RecollectionProjector;
  private readonly p4MaxCandidates: number;
  private readonly maxPendingRequests: number;
  private readonly maxPendingEvidencePerRequest: number;
  private readonly now: () => string;

  /** coalesced pending 请求（有界）。 */
  private pendingRequests: BustRequest[] = [];
  /** 当前已发布 generation（fail-closed：BUST 失败后为 undefined）。 */
  private currentGeneration: ContextGenerationV3 | undefined;
  private runInProgress = false;
  private bustSequence = 0;
  private lastRun:
    | {
        ok: boolean;
        error?: string;
        bustId?: string;
        at: string;
      }
    | undefined;

  constructor(options: BustCoordinatorOptions) {
    this.contextLineageId = options.contextLineageId;
    this.contributors = options.contributors ?? [];
    this.committedCompartments = options.committedCompartments;
    this.memoryCoordinator = options.memoryCoordinator;
    this.contextStore = options.contextStore;
    this.retirementPort = options.retirementPort;
    this.p4Projector = options.p4Projector ?? new P4RecollectionProjector();
    this.p4MaxCandidates = options.p4MaxCandidates ?? DEFAULT_P4_MAX_CANDIDATES;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.maxPendingEvidencePerRequest =
      options.maxPendingEvidencePerRequest ?? DEFAULT_MAX_PENDING_EVIDENCE_PER_REQUEST;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 提交一次 BUST 请求（唯一入口；reason 仅用于审计）。coalesce：
   * 相同 reason 的请求合并 evidence；pending 有界（超限合并到最近请求）。
   * 返回当前是否仍有 pending（= true，除非实现不允许 pending）。
   */
  requestBust(reason: BustReason, evidence: BustEvidence): boolean {
    if (!BUST_REASONS.includes(reason)) {
      throw new Error(`bust coordinator: unknown reason ${JSON.stringify(reason)} (fail closed)`);
    }
    if (
      evidence === null ||
      typeof evidence !== "object" ||
      evidence.schemaId !== "iris.bust_evidence.v1"
    ) {
      throw new Error("bust coordinator: evidence must be a BustEvidence object (fail closed)");
    }
    const existing = this.pendingRequests.find((request) => request.reason === reason);
    const requestedAt = this.now();
    if (existing !== undefined) {
      existing.evidence = this.mergeEvidence(existing.evidence, evidence);
      return true;
    }
    if (this.pendingRequests.length >= this.maxPendingRequests) {
      // 有界：超限时合并到最近一个 pending 请求（不无界增长）。
      const last = this.pendingRequests[this.pendingRequests.length - 1];
      if (last !== undefined) {
        last.evidence = this.mergeEvidence(last.evidence, evidence);
      }
      return true;
    }
    this.pendingRequests.push({ reason, evidence, requestedAt });
    return true;
  }

  /** 合并证据（有界：sourceRefs/receiptIds 去重并截断）。 */
  private mergeEvidence(a: BustEvidence, b: BustEvidence): BustEvidence {
    const sourceRefs = [...new Set([...(a.sourceRefs ?? []), ...(b.sourceRefs ?? [])])].slice(
      0,
      this.maxPendingEvidencePerRequest,
    );
    const receiptIds = [...new Set([...(a.receiptIds ?? []), ...(b.receiptIds ?? [])])].slice(
      0,
      this.maxPendingEvidencePerRequest,
    );
    const details = [a.detail, b.detail].filter(
      (detail): detail is string => detail !== undefined && detail.length > 0,
    );
    return {
      schemaId: "iris.bust_evidence.v1",
      ...(details.length > 0 ? { detail: details.join("; ") } : {}),
      ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
      ...(receiptIds.length > 0 ? { receiptIds } : {}),
    };
  }

  /** 当前 pending 请求数（audit）。 */
  pendingCount(): number {
    return this.pendingRequests.length;
  }

  /** 未消费的 pending 请求（audit；不可变快照）。 */
  getPendingRequests(): readonly BustRequest[] {
    return this.pendingRequests.map((request) => ({
      reason: request.reason,
      evidence: { ...request.evidence },
      requestedAt: request.requestedAt,
    }));
  }

  /**
   * invalidation seam：把 sourceId 分发给各 contributor；任何 contributor
   * 认领则提交 canonical BUST 请求（source 变化不直接触发 rebuild）。
   */
  invalidateSource(sourceId: string, detail?: string): boolean {
    let invalidated = false;
    for (const contributor of this.contributors) {
      if (contributor.invalidate?.(sourceId) === true) {
        invalidated = true;
      }
    }
    if (invalidated) {
      this.requestBust("source_invalidation", {
        schemaId: "iris.bust_evidence.v1",
        ...(detail !== undefined ? { detail } : {}),
        sourceRefs: [sourceId],
      });
    }
    return invalidated;
  }

  /**
   * Phase F（Cordis）：可逆的 contributor 注册 seam。contributor 只提供
   * frozen snapshot / identity / hash 与 invalidation；不允许直接
   * push/splice generation。返回 disposer —— 调用后从本 coordinator 移除
   * 该 contributor（进程内注册，绝不触碰 durable 状态）。
   *
   * Fail-closed：同一 sourceId 二次注册抛错（authority 冲突不得
   * "最后注册者获胜"）。
   */
  registerContributor(contributor: ContextSourceContributor): () => void {
    if (this.contributors.some((existing) => existing.sourceId === contributor.sourceId)) {
      throw new Error(
        `bust coordinator: contributor ${contributor.sourceId} is already registered (fail closed)`,
      );
    }
    this.contributors = [...this.contributors, contributor];
    return () => {
      this.contributors = this.contributors.filter((existing) => existing !== contributor);
    };
  }

  /**
   * 返回当前已发布 generation（或 null）。fail-closed：BUST 失败后旧
   * generation 不被新请求使用（返回 null），不存在 LKG/previous-generation
   * fallback。
   */
  getCurrentGeneration(): ContextGenerationV3 | null {
    return this.currentGeneration ?? null;
  }

  /** 最近一次 BUST 运行结果（bounded audit）。 */
  getLastRun(): { ok: boolean; error?: string; bustId?: string; at: string } | undefined {
    return this.lastRun === undefined ? undefined : { ...this.lastRun };
  }

  /**
   * 在安全 provider 边界执行 canonical BUST full rebuild（若有 pending）。
   * 详细步骤见文件头注释。任何失败 fail-closed。
   */
  async runBustIfPending(): Promise<BustRunResult> {
    if (this.runInProgress) {
      // 非重入：本轮进行中，pending 留给下一轮（不并发 rebuild）。
      return {
        ran: false,
        published: false,
        failed: false,
        generation: this.getCurrentGeneration(),
      };
    }
    if (this.pendingRequests.length === 0) {
      return {
        ran: false,
        published: false,
        failed: false,
        generation: this.getCurrentGeneration(),
      };
    }
    this.runInProgress = true;
    const bustId = `bust-${this.contextLineageId}-${++this.bustSequence}`;
    try {
      // 1. coalesce 全部 pending（消费；run 期间的新请求留给下一轮）。
      const coalesced = this.pendingRequests;
      this.pendingRequests = [];

      // 2. 失效当前 generation：旧 generation 不再可被新请求使用。
      this.currentGeneration = undefined;

      // 3. 冻结权威 P0–P5 sources。
      const frozen = await this.freezeSources(coalesced, bustId);
      if (!frozen.ok) {
        throw new Error(frozen.error);
      }

      // 4. 用唯一 materializer 完整重建（含内建 fail-closed validation）。
      //    v3：current Context 直接包含 ContextUnit[]（无投影/重包装）。
      const generationId = `gen-${this.contextLineageId}-${this.bustSequence}-${bustId}`;
      const createdAt = this.now();
      const generation = buildContextGenerationV3(frozen.sources, generationId, createdAt);

      // 5. 原子发布（内存中替换 current generation；对象带 generationId+hash）。
      this.currentGeneration = generation;

      // 6. 发布成功后推进 represented/retired watermark（唯一调用点）：
      //    markRepresentedAndRetired 只允许在 BUST 原子发布事务内调用 ——
      //    事务由本 coordinator 在 ContextStore 上开启；store 的事务标志
      //    断言保证事务外调用（绕过 BUST）fail-closed。任何失败回滚事务并
      //    fail-closed（watermark 不推进、generation 不发布）。
      this.contextStore.beginBustTransaction();
      try {
        this.retirementPort.markRepresentedAndRetired({
          contextLineageId: this.contextLineageId,
          contextGenerationId: generation.header.contextGenerationId,
          contextGenerationHash: generation.header.contextGenerationHash,
          representedThroughContextSeq: frozen.representedThrough,
          retiredThroughContextSeq: frozen.retiredThrough,
        });
        this.contextStore.commitBustTransaction();
      } catch (error) {
        this.contextStore.rollbackBustTransaction();
        throw error;
      }

      this.lastRun = { ok: true, bustId, at: this.now() };
      return {
        ran: true,
        published: true,
        failed: false,
        generation,
        bustId,
      };
    } catch (error) {
      // 失败 fail-closed：不发布半 generation（已发布的也失效）、watermark
      // 不推进（retirement 事务回滚）、旧 generation 不被新请求使用。
      this.currentGeneration = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.lastRun = { ok: false, error: message, bustId, at: this.now() };
      return {
        ran: true,
        published: false,
        failed: true,
        error: message,
        generation: null,
        bustId,
      };
    } finally {
      this.runInProgress = false;
    }
  }

  /** 冻结全部权威 source（P0–P5）并计算 sourceSnapshotHash / 推进边界。 */
  private async freezeSources(
    coalesced: readonly BustRequest[],
    bustId: string,
  ): Promise<
    | {
        ok: true;
        sources: import("./generation-builder.js").FrozenContextSourcesV3;
        representedThrough: number;
        retiredThrough: number;
      }
    | { ok: false; error: string }
  > {
    void coalesced;
    // P0–P2：contributor seam（允许零 contributor → 空层）。contributor 只提供
    // 冻结 source 投影；Context admission（materializeContextUnit）负责物化
    // ContextUnit（不重新包装、不复制为第二 DTO）。
    const p0Units: ContextUnit[] = [];
    const p1Units: ContextUnit[] = [];
    const p2Units: ContextUnit[] = [];
    for (const contributor of this.contributors) {
      const projected = contributor.project();
      const target =
        contributor.layer === "p0" ? p0Units : contributor.layer === "p1" ? p1Units : p2Units;
      for (const unit of projected) {
        const error = validateProjectedUnit(unit);
        if (error !== null) {
          return { ok: false, error: `contributor ${contributor.sourceId}: ${error}` };
        }
        target.push(convertProjectedUnitToContextUnit(this.contextLineageId, unit));
      }
    }

    // P3：committed Compartments（lineage-scoped，compartment_sequence 升序）。
    // Compartment source → Context admission → 新的 ContextUnit（basis =
    // 被表示的旧 P5 单元 ids；不是把旧 Unit 改造成 CompartmentUnit）。
    const compartments = this.committedCompartments.listCommitted(this.contextLineageId);
    const compartmentHead = compartments.reduce(
      (max, compartment) => Math.max(max, compartment.endContextSeq),
      0,
    );

    // P5：先确定 P3-covered 边界（prospective represented-through）。读取自
    // currentRepresented 以来的 live ContextUnit 池（含即将被本 compartment
    // 覆盖的单元），再按 representedThrough 切分：
    //   - contextSeq > representedThrough → 仍在 P5（未覆盖）；
    //   - contextSeq ∈ compartment range → 作为 P3 的 immutable basis（被表示的
    //     旧 P5 单元）。
    const lineage = this.contextStore.getLineageByLineageId(this.contextLineageId);
    const currentRepresented = lineage?.representedThroughContextSeq ?? 0;
    const representedThrough = Math.max(currentRepresented, compartmentHead);
    const retiredThrough = representedThrough;
    const p5Pool = this.contextStore.listLiveContextUnitsForP5WithSeq(
      this.contextLineageId,
      currentRepresented,
    );
    const p5Units = p5Pool
      .filter((entry) => entry.contextSeq > representedThrough)
      .map((entry) => entry.unit);

    const p3Units = compartments.map((compartment) => {
      const covered = p5Pool
        .filter(
          (entry) =>
            entry.contextSeq >= compartment.startContextSeq &&
            entry.contextSeq <= compartment.endContextSeq,
        )
        .map((entry) => entry.unit.unitId);
      return materializeContextUnit(
        this.contextLineageId,
        projectCommittedCompartmentCandidate(compartment, covered),
      );
    });

    // P4：Context-owned Recall Intent（由冻结认知状态构建）→ coordinator →
    // provider-neutral snapshot → Context-owned projection → Context admission。
    // sourceSnapshotHash 依赖 P4 内容 → 自指：先以不含 P4 的确定性摘要构建
    // intent（recall 上下文身份），recall 后再重算完整 sourceSnapshotHash。
    const intentWithoutP4Hash = this.computeSourceSnapshotHash({
      lineageId: this.contextLineageId,
      p0Units,
      p1Units,
      p2Units,
      p3Units,
      p4Units: [],
      p5Units,
    });
    const intent: RecallIntent = {
      schemaId: "iris.recall_intent.v1",
      contextLineageId: this.contextLineageId,
      contextGenerationId: bustId,
      frozenAt: this.now(),
      querySummary: `lineage ${this.contextLineageId}: ${p5Units.length} live units, ${compartments.length} committed compartments, head ${representedThrough}`,
      budget: { maxCandidates: this.p4MaxCandidates },
      sourceSnapshotHash: intentWithoutP4Hash,
    };
    const snapshot = await this.memoryCoordinator.recall(intent);
    const p4Candidates = this.p4Projector.project(snapshot, {
      contextLineageId: this.contextLineageId,
      maxCandidates: this.p4MaxCandidates,
    });
    const p4Units = p4Candidates.map((candidate) =>
      materializeContextUnit(this.contextLineageId, candidate),
    );

    const sourceSnapshotHash = this.computeSourceSnapshotHash({
      lineageId: this.contextLineageId,
      p0Units,
      p1Units,
      p2Units,
      p3Units,
      p4Units,
      p5Units,
    });

    return {
      ok: true,
      sources: {
        contextLineageId: this.contextLineageId,
        sourceSnapshotHash,
        p0Units,
        p1Units,
        p2Units,
        p3Units,
        p4Units,
        p5Units,
      },
      representedThrough,
      retiredThrough,
    };
  }

  /** 确定性 source snapshot hash（覆盖全部冻结 P0–P5 source 的 ContextUnit）。 */
  private computeSourceSnapshotHash(input: {
    lineageId: string;
    p0Units: readonly ContextUnit[];
    p1Units: readonly ContextUnit[];
    p2Units: readonly ContextUnit[];
    p3Units: readonly ContextUnit[];
    p4Units: readonly ContextUnit[];
    p5Units: readonly ContextUnit[];
  }): string {
    const sourceBasis = (unit: ContextUnit): string => {
      const ref = unit.sourceRef as unknown as Record<string, string>;
      const identity = ref["sourceId"] ?? `${ref["sessionId"] ?? ""}|${ref["messageId"] ?? ""}`;
      return `${ref["schemaId"] ?? ""}|${identity}|${ref["sourceHash"] ?? ""}`;
    };
    const layers = [input.p0Units, input.p1Units, input.p2Units, input.p3Units, input.p4Units].map(
      (units) =>
        units.map((unit) => [
          unit.unitId,
          unit.contentSchemaId,
          sourceBasis(unit),
          unit.contentHash,
        ]),
    );
    const p5 = input.p5Units.map((unit) => [unit.unitId, unit.contentHash]);
    const payload = canonicalJson({
      lineageId: input.lineageId,
      layers,
      p5,
    });
    return sha256(payload);
  }
}

/** 校验 contributor/投影 unit 的最小形状（fail-closed）。 */
function validateProjectedUnit(unit: P0P1P2P3P4Unit): string | null {
  if (typeof unit.contextUnitId !== "string" || unit.contextUnitId.length === 0) {
    return "unit contextUnitId must be a non-empty string";
  }
  if (unit.source === null || typeof unit.source !== "object") {
    return "unit source must be an object";
  }
  if (
    unit.source.schemaId !== CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID ||
    typeof unit.source.sourceId !== "string" ||
    unit.source.sourceId.length === 0 ||
    typeof unit.source.sourceHash !== "string" ||
    unit.source.sourceHash.length === 0
  ) {
    return "unit source must carry a valid ContextUnitSourceRefV1 (sourceId + sourceHash)";
  }
  if (typeof unit.semanticSchemaId !== "string" || unit.semanticSchemaId.length === 0) {
    return "unit semanticSchemaId must be a non-empty string";
  }
  if (unit.semanticContent === undefined) {
    return "unit semanticContent is required";
  }
  return null;
}

/** 装配工厂（Phase F 接线 Cordis 时再扩展）。 */
export function createBustCoordinator(options: BustCoordinatorOptions): BustCoordinator {
  return new BustCoordinator(options);
}

/**
 * Feature 3：把 contributor seam 的 pre-projected unit（P0P1P2P3P4Unit，
 * legacy 兼容形状，iris_agent consumer 仍提供）转换为中性 AdmissionCandidate，
 * 再经 Context admission materialize 为 ContextUnit（同一 materializer；
 * 不重新包装为 generation-only DTO）。
 */
function convertProjectedUnitToContextUnit(lineageId: string, unit: P0P1P2P3P4Unit): ContextUnit {
  return materializeContextUnit(lineageId, {
    sourceRef: unit.source,
    contentSchemaId: unit.semanticSchemaId,
    content: unit.semanticContent,
  });
}
