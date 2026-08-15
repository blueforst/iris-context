/**
 * Phase F（Cordis）：irisContext —— Context 服务（Identity scope）。
 *
 * 组合 ContextStore（context.db 唯一 owner）+ ContextAdmission（DSH Message →
 * ContextUnit 统一 ingress）+ BustCoordinator（唯一 canonical BUST
 * materializer）+ 当前 generation。
 *
 * 生命周期（reversible effects）：
 *  - `open(dataRoot)` 是可逆 effect：打开 context.db + ingest + BUST
 *    coordinator，返回 disposer（close）。拥有 fiber 卸载时自动 close。
 *  - `close()` 只摘除进程内句柄/注册，绝不删除 durable context.db 行、
 *    Compartment、Publication、receipt、archive（Cordis "effect 不删 durable
 *    state" 约定）。
 *  - `registerContributor(contributor)` 是可逆注册（BustCoordinator 的
 *    ContextSourceContributor seam；只提供 frozen snapshot/identity/hash +
 *    invalidation，不允许直接 push/splice generation）。
 *
 * 单向依赖：Ledger → Historian → Compartment Source → Materializer → BUST。
 * 本服务不反向 inject Historian；compartment source（CommittedCompartmentReadPort）
 * 由装配点在构造时以窄 value 端口注入（见 createIrisContextPlugin）。
 *
 * Scope：本服务在 Identity scope 注册（Root/Deployment 之下、Runtime Agent
 * Scope 之上）。Runtime Agent scope 是 Identity 之下的独立 fiber，其 dispose
 * 只清理该 agent 的进程内注册，绝不 dispose Identity services、也绝不触碰
 * durable 状态。
 */

import { Context, Service } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { DSH_MESSAGE_REF_V1_SCHEMA_ID, type ContextUnit } from "../contracts/context-unit.js";
import type { ContextRetirementPortV1 } from "../contracts/context-retirement.js";
import { ContextAdmission } from "../context/context-admission.js";
import {
  BustCoordinator,
  type BustEvidence,
  type BustReason,
  type BustRunResult,
  type ContextSourceContributor,
} from "../context/bust-coordinator.js";
import type { CommittedCompartmentReadPort } from "../context/committed-compartment-read-port.js";
import {
  ContextStore,
  type ContextStoreOpenOptions,
  type CreateLineageInput,
} from "../context/context-store.js";
import {
  createContextHistoryReadPort,
  type ContextHistoryReadPort,
} from "../context/history-read-port.js";
import { createContextRetirementPort } from "../context/context-retirement-port.js";
import { MemoryIntegrationCoordinator } from "../memory/memory-integration-coordinator.js";
import type { MemoryService } from "./memory-service.js";

/** 从 dataRoot 派生稳定 identity-level lineage id（one per data root）。 */
export function deriveLineageId(dataRoot: string): string {
  return `lineage-${createHash("sha256").update(dataRoot, "utf8").digest("hex").slice(0, 24)}`;
}

/** 零 Compartment 的窄读端口（Context 无 Historian 时的合法 P3 空态）。 */
const EMPTY_COMMITTED_COMPARTMENTS: CommittedCompartmentReadPort = {
  listCommitted: () => [],
};

export interface ContextServiceOptions {
  /** identity-level lineage id（one per data root）。 */
  lineageId: string;
  /**
   * P3 committed Compartment 窄读端口（values-only）。由装配点从
   * HistorianStore 适配注入；缺省 = 空（Context 无 Historian 的合法配置）。
   */
  committedCompartments?: CommittedCompartmentReadPort;
  /** irisMemory（zero-or-one adapter；BUST-only recall 授权门）。 */
  memoryService?: MemoryService;
  /** P4 recall 预算上限（RecallIntent.budget.maxCandidates）。 */
  p4MaxCandidates?: number;
  /** pending 请求有界上限。 */
  maxPendingRequests?: number;
  /** 每个 pending 请求的 evidence 有界上限。 */
  maxPendingEvidencePerRequest?: number;
  /** 时间注入（默认 new Date().toISOString()）。 */
  now?: () => string;
}

export interface ContextOpenOptions {
  /** ContextStore 打开选项（cap 注入等；lineageId 由服务持有）。 */
  contextStoreOptions?: ContextStoreOpenOptions;
}

/**
 * irisContext —— Context 服务。ContextStore + ContextAdmission +
 * BustCoordinator + 当前 generation；暴露给 Historian 的窄端口
 * （historyPort / retirementPort）只以 VALUE 呈现。
 */
export class ContextService extends Service {
  static inject = [] as const;

  /** identity-level lineage id（one per data root）。 */
  readonly lineageId: string;

  private readonly committedCompartments: CommittedCompartmentReadPort;
  private readonly memoryService: MemoryService | undefined;
  private readonly p4MaxCandidates: number | undefined;
  private readonly maxPendingRequests: number | undefined;
  private readonly maxPendingEvidencePerRequest: number | undefined;
  private readonly now: (() => string) | undefined;

  private storeValue: ContextStore | undefined;
  private admissionValue: ContextAdmission | undefined;
  private bustValue: BustCoordinator | undefined;
  private historyPortValue: ContextHistoryReadPort | undefined;
  private retirementPortValue: ContextRetirementPortV1 | undefined;
  private closed = true;

  constructor(ctx: Context, options: ContextServiceOptions) {
    super(ctx, "irisContext");
    this.lineageId = options.lineageId;
    this.committedCompartments = options.committedCompartments ?? EMPTY_COMMITTED_COMPARTMENTS;
    this.memoryService = options.memoryService;
    this.p4MaxCandidates = options.p4MaxCandidates;
    this.maxPendingRequests = options.maxPendingRequests;
    this.maxPendingEvidencePerRequest = options.maxPendingEvidencePerRequest;
    this.now = options.now;
  }

  // ---- 窄端口（供 irisHistorian 经 inject 消费；只暴露 VALUE）-------------

  /** Context-owned history read/claim 窄端口（values-only）。 */
  get historyPort(): ContextHistoryReadPort {
    return this.requireOpen(this.historyPortValue, "historyPort");
  }

  /** Context retirement / ACK 窄端口（values-only）。 */
  get retirementPort(): ContextRetirementPortV1 {
    return this.requireOpen(this.retirementPortValue, "retirementPort");
  }

  // ---- 生命周期（reversible effects）-------------------------------------

  /**
   * 打开 context.db + ingest + BUST coordinator（可逆 effect）。
   * 返回 disposer（close）；拥有 fiber 卸载时自动 close。
   * 二次 open（未 close）→ 抛错（fail-closed：一个 dataRoot 恰一个
   * materializer）。
   */
  open(dataRoot: string, options: ContextOpenOptions = {}): () => void {
    if (!this.closed) {
      throw new Error(
        `iris context: already open for lineage ${this.lineageId} (fail closed; ` +
          "exactly one materializer per data root — close() before reopen)",
      );
    }
    const store = ContextStore.open(join(dataRoot, "context.db"), {
      lineageId: this.lineageId,
      ...options.contextStoreOptions,
    });
    // DSH 正常路径的统一 admission（ContextAdmission；DSH Message → ContextUnit）。
    const admission = new ContextAdmission(store);
    // BUST-only recall 授权门：装配 irisMemory 时，BUST coordinator 经
    // MemoryService.recall 走授权门（beginBustCycle/endBustCycle 之间）；
    // 未装配时直接使用裸 coordinator（zero-backend 语义，recall 同样只被
    // BUST 调用——本服务不暴露任何 invocation-time recall 入口）。
    const memoryService = this.memoryService;
    const memoryCoordinator: MemoryIntegrationCoordinator =
      memoryService === undefined
        ? new MemoryIntegrationCoordinator()
        : ({ recall: (intent) => memoryService.recall(intent) } as MemoryIntegrationCoordinator);
    const bust = new BustCoordinator({
      contextLineageId: this.lineageId,
      committedCompartments: this.committedCompartments,
      memoryCoordinator,
      contextStore: store,
      retirementPort: createContextRetirementPort(store),
      ...(this.p4MaxCandidates !== undefined ? { p4MaxCandidates: this.p4MaxCandidates } : {}),
      ...(this.maxPendingRequests !== undefined
        ? { maxPendingRequests: this.maxPendingRequests }
        : {}),
      ...(this.maxPendingEvidencePerRequest !== undefined
        ? { maxPendingEvidencePerRequest: this.maxPendingEvidencePerRequest }
        : {}),
      ...(this.now !== undefined ? { now: this.now } : {}),
    });
    this.storeValue = store;
    this.admissionValue = admission;
    this.bustValue = bust;
    this.historyPortValue = createContextHistoryReadPort(store);
    this.retirementPortValue = createContextRetirementPort(store);
    this.closed = false;
    return () => {
      this.close();
    };
  }

  /** 是否已 open（装配点/auto-BUST 监听器用）。 */
  isOpen(): boolean {
    return !this.closed;
  }

  /**
   * 关闭（可逆）：只摘除进程内句柄/注册（store/ingest/bust/端口引用）。
   * 绝不删除 durable context.db 行、Compartment、Publication、receipt、
   * archive（Cordis "effect 不删 durable state" 约定）。
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.admissionValue = undefined;
    this.storeValue = undefined;
    this.bustValue = undefined;
    this.historyPortValue = undefined;
    this.retirementPortValue = undefined;
  }

  // ---- Context ingress（DSH 正常路径）--------------------------------------

  /**
   * DSH 正常路径的统一 Context admission：把一条 runtime-origin DSH message
   * （user/message | assistant/message | tool/result）接纳为 ContextUnit。
   *
   * - `sessionId` / `messageId` 构成 DshMessageRef（messageId=identity、
   *   sessionId=ownership；`eventSeq` 仅作 archive-local 定位键）；
   * - canonical content 由调用方（DSH runtime adapter，iris_agent）提供；
   *   本 admission 校验 DshMessageRef 形状 + 语义 schema + canonical hash；
   * - `runtimeSourceKind`（可选，防 echo 纵深防御）：user-role 消息声明为
   *   plugin/injected 来源 → fail-closed 拒绝（合成上下文不是真人 experience）；
   * - exactly-once：同一 source 幂等返回既有 Unit；语义变化 → 新 Unit。
   */
  admitRuntimeMessage(input: {
    sessionId: string;
    messageId: string;
    eventSeq?: number;
    contentSchemaId: string;
    content: import("../contracts/context-unit.js").JsonValue;
    runtimeSourceKind?: "user" | "plugin" | "model" | "tool" | "other";
    sourceHash?: string;
  }): ContextUnit {
    const admission = this.requireOpen(this.admissionValue, "admitRuntimeMessage");
    return admission.admit({
      sourceRef: {
        schemaId: DSH_MESSAGE_REF_V1_SCHEMA_ID,
        sessionId: input.sessionId,
        messageId: input.messageId,
        ...(input.eventSeq !== undefined ? { eventSeq: input.eventSeq } : {}),
        ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
      },
      contentSchemaId: input.contentSchemaId,
      content: input.content,
      runtimeSessionId: input.sessionId,
      ...(input.runtimeSourceKind !== undefined
        ? { runtimeSourceKind: input.runtimeSourceKind }
        : {}),
    });
  }

  /** 创建 durable Session→lineage 绑定（host 在 session 进入时调用）。 */
  createLineage(input: CreateLineageInput): void {
    this.requireOpen(this.storeValue, "createLineage").createLineage(input);
  }

  /** 底层 ContextStore（durable context.db 唯一 owner；仅供同仓装配/诊断）。 */
  getStore(): ContextStore {
    return this.requireOpen(this.storeValue, "getStore");
  }

  // ---- canonical BUST ------------------------------------------------------

  /**
   * 提交一次 BUST 请求（唯一入口；reason 仅用于审计；coalesce + 有界）。
   * 发出 typed event `iris/bust-requested`（审计/可观测）。
   */
  requestBust(reason: BustReason, evidence: BustEvidence): boolean {
    const bust = this.requireOpen(this.bustValue, "requestBust");
    const result = bust.requestBust(reason, evidence);
    this.ctx.emit("iris/bust-requested", reason);
    return result;
  }

  /**
   * 在安全 provider 边界执行 canonical BUST full rebuild（若有 pending）。
   * 发布成功发出 typed event `iris/context-generation-published`。
   * 本方法是 P4 recall 的唯一授权周期（经 irisMemory.beginBustCycle）。
   */
  async runBustIfPending(): Promise<BustRunResult> {
    const bust = this.requireOpen(this.bustValue, "runBustIfPending");
    this.memoryService?.beginBustCycle();
    try {
      const result = await bust.runBustIfPending();
      if (result.published && result.generation !== null) {
        this.ctx.emit("iris/context-generation-published", result.generation);
      }
      return result;
    } finally {
      this.memoryService?.endBustCycle();
    }
  }

  /** 当前已发布 generation（v3；fail-closed：BUST 失败后为 null，无 LKG fallback）。 */
  getCurrentGeneration(): import("../../contracts/generated/types.js").ContextGenerationV3 | null {
    return this.requireOpen(this.bustValue, "getCurrentGeneration").getCurrentGeneration();
  }

  /** 当前 pending 请求数（audit）。 */
  pendingCount(): number {
    return this.requireOpen(this.bustValue, "pendingCount").pendingCount();
  }

  /** 最近一次 BUST 运行结果（bounded audit）。 */
  getLastRun(): { ok: boolean; error?: string; bustId?: string; at: string } | undefined {
    return this.requireOpen(this.bustValue, "getLastRun").getLastRun();
  }

  /**
   * 可逆注册 P0–P2 contributor（ContextSourceContributor seam；只提供
   * frozen snapshot/identity/hash + invalidation）。返回 disposer；拥有
   * fiber 卸载时自动摘除。同一 sourceId 二次注册抛错（fail-closed）。
   */
  registerContributor(contributor: ContextSourceContributor): () => void | Promise<void> {
    const bust = this.requireOpen(this.bustValue, "registerContributor");
    return this.ctx.effect(
      () => bust.registerContributor(contributor),
      `irisContext.registerContributor(${contributor.sourceId})`,
    );
  }

  /** invalidation seam：sourceId 分发给各 contributor（→ requestBust）。 */
  invalidateSource(sourceId: string, detail?: string): boolean {
    return this.requireOpen(this.bustValue, "invalidateSource").invalidateSource(sourceId, detail);
  }

  private requireOpen<T>(value: T | undefined, method: string): T {
    if (value === undefined) {
      throw new Error(
        `iris context: ${method} requires an open context service ` +
          "(call open(dataRoot) first; plugin unload/reload rebuilds from durable state)",
      );
    }
    return value;
  }
}
