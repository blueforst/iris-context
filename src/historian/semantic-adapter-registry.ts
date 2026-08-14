/**
 * HistorianSemanticAdapterRegistry（Phase D）—— semantic adapter 注册表。
 *
 * 权威来源：Notion [Long-Term Memory Service & Plugin Boundary] + Phase D
 * 设计笔记 §4。
 *
 *  - ownership-scoped：adapter 注册时声明自己拥有的 semanticSchemaId 集合；
 *    同一 schemaId 只能一个 adapter（冲突 fail closed）；
 *  - adapter 能力：对自有 schema 的 observation 做解释/标注（provider-neutral），
 *    不得修改 disposition/provenance/source basis，不得直接生成最终
 *    Compartment 或 MemoryPublication（解释返回值是唯一效果；输入对象不可变）；
 *  - frozen processing profile：batch claim 时冻结 profile（adapter 版本集
 *    hash）；处理中 plugin 变化只影响后续 batch；
 *  - 注册表本身纯内存，无持久化；profileId 由 HistorianStore 记录到
 *    publication（historian_semantic_adapters / historian_processing_profiles
 *    无需建表 —— profile 是内容 hash，重启后可重新从代码加载 adapter 集）。
 */

import { createHash } from "node:crypto";

import type { ContextMessageUnitV1, JsonValue } from "../contracts/context-v27.js";
import type { MemoryObservationV1 } from "../contracts/memory-publication.js";

/**
 * 一个 semantic adapter。`schemaIds` 是它声明拥有的 semanticSchemaId 集合
 * （ownership-scoped）；`version` 是该 adapter 的实现版本（参与 frozen
 * processing profile 的 hash）。
 */
export interface SemanticAdapter {
  readonly schemaIds: readonly string[];
  readonly version: string;
  /**
   * 对自有 schema 的 observation 做解释/标注。返回可选 annotation（中性
   * JsonValue）。约束（不可变输入）：
   *   - 不得修改 unit/observation 的 disposition / provenance / source basis；
   *   - 不得直接生成最终 Compartment 或 MemoryPublication；
   *   - 返回值是唯一效果。
   */
  interpret?(input: { unit: ContextMessageUnitV1; observation: MemoryObservationV1 }): {
    annotation?: JsonValue;
  };
}

/** 冻结的 processing profile（batch claim 时的 adapter 版本集快照）。 */
export interface FrozenProcessingProfile {
  profileId: string;
  adapters: Array<{ version: string; schemaIds: string[] }>;
}

/** schemaId 所有权冲突（fail closed）。 */
export class SemanticAdapterConflictError extends Error {
  constructor(schemaId: string) {
    super(
      `historian semantic adapter registry: schemaId ${schemaId} is already owned by another adapter (fail closed)`,
    );
    this.name = "SemanticAdapterConflictError";
  }
}

/** adapter 试图解释非自有 schema 的 observation（fail closed）。 */
export class SemanticAdapterOwnershipError extends Error {
  constructor(schemaId: string) {
    super(
      `historian semantic adapter registry: no adapter owns schemaId ${schemaId}; ` +
        "an adapter may only interpret observations of its own schemaIds",
    );
    this.name = "SemanticAdapterOwnershipError";
  }
}

/** adapter 解释过程中试图修改输入（fail closed）。 */
export class SemanticAdapterMutationError extends Error {
  constructor(adapterVersion: string) {
    super(
      `historian semantic adapter registry: adapter ${adapterVersion} mutated its input; ` +
        "interpret must be read-only (disposition/provenance/source basis are immutable)",
    );
    this.name = "SemanticAdapterMutationError";
  }
}

/** 确定性 processing profile id：sha256 over sorted (version, schemaIds)。 */
export function processingProfileIdOf(adapters: ReadonlyArray<SemanticAdapter>): string {
  const entries = [...adapters]
    .map((adapter) => ({
      version: adapter.version,
      schemaIds: [...adapter.schemaIds].sort(),
    }))
    .sort((a, b) => {
      if (a.version !== b.version) {
        return a.version < b.version ? -1 : 1;
      }
      const aIds = a.schemaIds.join(",");
      const bIds = b.schemaIds.join(",");
      return aIds < bIds ? -1 : aIds > bIds ? 1 : 0;
    });
  return createHash("sha256")
    .update(
      entries.map((entry) => `${entry.version}:${entry.schemaIds.join(",")}`).join("\n"),
      "utf8",
    )
    .digest("hex");
}

/**
 * 纯内存、ownership-scoped 的 semantic adapter 注册表。
 * 无持久化：profileId 由调用方（HistorianStore）记录到 publication。
 */
export class HistorianSemanticAdapterRegistry {
  private readonly adapters = new Map<string, SemanticAdapter>();

  /** 注册一个 adapter；同一 schemaId 已被其他 adapter 拥有 → 抛错（fail closed）。 */
  registerAdapter(adapter: SemanticAdapter): void {
    for (const schemaId of adapter.schemaIds) {
      const existing = this.adapters.get(schemaId);
      if (existing !== undefined && existing !== adapter) {
        throw new SemanticAdapterConflictError(schemaId);
      }
      this.adapters.set(schemaId, adapter);
    }
  }

  /**
   * Phase F（Cordis）：可逆注销。只移除 `adapter` 自己拥有的 schemaId 条目
   * （其他 adapter 的条目不动）。注册表纯内存，注销不触碰 durable 状态。
   */
  removeAdapter(adapter: SemanticAdapter): void {
    for (const schemaId of adapter.schemaIds) {
      if (this.adapters.get(schemaId) === adapter) {
        this.adapters.delete(schemaId);
      }
    }
  }

  /** 查询 schemaId 的 owner adapter（无 → undefined）。 */
  getAdapter(schemaId: string): SemanticAdapter | undefined {
    return this.adapters.get(schemaId);
  }

  /** schemaId 是否有 owner（ownership 判定）。 */
  owns(schemaId: string): boolean {
    return this.adapters.has(schemaId);
  }

  /** 已注册的独立 adapter（去重）。 */
  registeredAdapters(): SemanticAdapter[] {
    return [...new Set(this.adapters.values())];
  }

  /**
   * 冻结当前 processing profile（adapter 版本集 hash）。batch claim 时调用；
   * 处理中 plugin 变化只影响后续 batch。
   */
  frozenProcessingProfile(): FrozenProcessingProfile {
    const adapters = this.registeredAdapters();
    return {
      profileId: processingProfileIdOf(adapters),
      adapters: adapters.map((adapter) => ({
        version: adapter.version,
        schemaIds: [...adapter.schemaIds],
      })),
    };
  }

  /**
   * 对 observation 调用其 owner adapter 的 interpret（若存在）。只解释
   * 自有 schema；无 owner → 返回 undefined（不是错误）。输入不可变：
   * interpret 之后重新校验 observation 未被修改（fail closed）。
   */
  invokeInterpret(input: {
    unit: ContextMessageUnitV1;
    observation: MemoryObservationV1;
  }): { annotation?: JsonValue } | undefined {
    const adapter = this.adapters.get(input.observation.semanticSchemaId);
    if (adapter?.interpret === undefined) {
      return undefined;
    }
    const unitBefore = JSON.stringify(input.unit);
    const observationBefore = JSON.stringify(input.observation);
    const result = adapter.interpret({ unit: input.unit, observation: input.observation });
    if (
      JSON.stringify(input.unit) !== unitBefore ||
      JSON.stringify(input.observation) !== observationBefore
    ) {
      throw new SemanticAdapterMutationError(adapter.version);
    }
    return result;
  }
}
