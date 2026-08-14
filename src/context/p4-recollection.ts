/**
 * P4RecollectionProjector —— Context-owned P4 projection（Phase E，BUST-only）。
 *
 * 权威来源：Notion v29 P4 Recollection / BUST-only Override：
 *   - Memory Service 只返回 provider-neutral RecollectionSnapshot，不能创建
 *     ContextUnitV2；Context 独占 P4 的 validation/sanitization/dedupe/
 *     budget/ordering 与 ContextUnitV2 构造权；
 *   - P4 是 generation-scoped、non-authoritative、provenance-bearing 的
 *     回忆快照；不推进 Context retirement，不覆盖当前 committed evidence；
 *   - 本 projector 只由 canonical BUST full rebuild 调用（唯一 P4 更新路径）。
 *
 * 投影规则：
 *   - status='disabled'（zero-backend）→ P4 空数组（合法组合）；
 *   - status='unavailable' → 显式 unavailable marker unit（绝不伪装为"无记忆"）；
 *   - status='ready' → 对 candidates 做 validation/sanitization（丢弃畸形
 *     candidate）、dedupe（recollectionId / statement hash）、budget（上限）、
 *     ordering（relevanceScore 降序，ties 按 recollectionId 升序 —— 确定性）。
 *
 * contextUnitId 确定性：sha256(snapshotId|recollectionId) 前缀；source 绑定
 * snapshot identity/revision/hash（generation-scoped 内固定）。
 */

import { createHash } from "node:crypto";

import type { JsonValue } from "../contracts/context-v27.js";
import { CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID } from "../contracts/context-v27.js";
import type {
  RecollectionCandidate,
  RecollectionSnapshot,
} from "../memory/memory-integration-coordinator.js";
import type { P0P1P2P3P4Unit } from "./generation-builder.js";

/** P4 语义 schema id（generated registry 权威）。 */
export const RECOLLECTION_SEMANTIC_SCHEMA_ID = "iris.semantic.recollection.v1" as const;

/** P4 source schema id（RecollectionSnapshot identity）。 */
export const RECOLLECTION_SOURCE_SCHEMA_ID = "iris.recollection_snapshot.v1" as const;

export interface P4ProjectOptions {
  contextLineageId: string;
  /** recall 预算上限（来自 Context-owned RecallIntent.budget.maxCandidates）。 */
  maxCandidates: number;
}

/** 校验 candidate 的形状（fail-conservative：畸形 candidate 被丢弃，不进入 P4）。 */
function isValidCandidate(value: unknown): value is RecollectionCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["recollectionId"] !== "string" || candidate["recollectionId"].length === 0) {
    return false;
  }
  if (typeof candidate["statement"] !== "string" || candidate["statement"].length === 0) {
    return false;
  }
  const trust = candidate["sourceTrust"];
  if (trust !== "observed" && trust !== "verified" && trust !== "generated") {
    return false;
  }
  for (const key of ["referenceTime", "provenanceRef"] as const) {
    const value = candidate[key];
    if (value !== undefined && typeof value !== "string") {
      return false;
    }
  }
  const score = candidate["relevanceScore"];
  if (score !== undefined && typeof score !== "number") {
    return false;
  }
  return true;
}

/** 净化 statement（去除控制字符/空串由 isValidCandidate 保证）。 */
function sanitizeStatement(statement: string): string {
  // eslint-disable-next-line no-control-regex
  return statement.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * P4RecollectionProjector —— Context-owned、exactly one、reconstructable。
 * 只消费规范化后的 RecollectionSnapshot，产出 P0P1P2P3P4Unit[]。
 */
export class P4RecollectionProjector {
  project(snapshot: RecollectionSnapshot, options: P4ProjectOptions): P0P1P2P3P4Unit[] {
    if (options.maxCandidates < 0) {
      throw new Error("P4RecollectionProjector: maxCandidates must be >= 0 (fail closed)");
    }
    if (snapshot.status === "disabled") {
      // zero-backend：P4 空（合法组合；Context/Historian 正常运行）。
      return [];
    }
    if (snapshot.status === "unavailable") {
      // 显式 unavailable marker —— 绝不伪装为"无记忆"。
      return [this.unavailableUnit(snapshot)];
    }
    if (snapshot.status !== "ready") {
      throw new Error(
        `P4RecollectionProjector: unknown snapshot status ${JSON.stringify(snapshot.status)} (fail closed)`,
      );
    }
    // sanitization：丢弃畸形 candidate。
    const sanitized: RecollectionCandidate[] = [];
    for (const candidate of snapshot.candidates) {
      if (!isValidCandidate(candidate)) {
        continue;
      }
      const statement = sanitizeStatement(candidate.statement);
      if (statement.length === 0) {
        continue;
      }
      sanitized.push({ ...candidate, statement });
    }
    // dedupe：recollectionId 去重（保留首个）；statement hash 去重（保留首个）。
    const byId = new Set<string>();
    const byStatement = new Set<string>();
    const deduped: RecollectionCandidate[] = [];
    for (const candidate of sanitized) {
      if (byId.has(candidate.recollectionId)) {
        continue;
      }
      const statementHash = sha256(candidate.statement);
      if (byStatement.has(statementHash)) {
        continue;
      }
      byId.add(candidate.recollectionId);
      byStatement.add(statementHash);
      deduped.push(candidate);
    }
    // budget：上限截断（有序截断在 ordering 后执行，保证全局最相关）。
    const ordered = [...deduped].sort((a, b) => {
      const scoreA = a.relevanceScore ?? 0;
      const scoreB = b.relevanceScore ?? 0;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return a.recollectionId < b.recollectionId ? -1 : a.recollectionId > b.recollectionId ? 1 : 0;
    });
    const selected = ordered.slice(0, options.maxCandidates);
    return selected.map((candidate) => this.availableUnit(snapshot, candidate));
  }

  /** ready 候选 → P0P1P2P3P4Unit（contextUnitId 确定性）。 */
  private availableUnit(
    snapshot: RecollectionSnapshot,
    candidate: RecollectionCandidate,
  ): P0P1P2P3P4Unit {
    const semanticContent: JsonValue = {
      schemaId: RECOLLECTION_SEMANTIC_SCHEMA_ID,
      status: "available",
      recollectionId: candidate.recollectionId,
      statement: candidate.statement,
      sourceTrust: candidate.sourceTrust,
      ...(candidate.referenceTime !== undefined ? { referenceTime: candidate.referenceTime } : {}),
      ...(candidate.provenanceRef !== undefined ? { provenanceRef: candidate.provenanceRef } : {}),
      ...(candidate.relevanceScore !== undefined
        ? { relevanceScore: candidate.relevanceScore }
        : {}),
    };
    return {
      contextUnitId: `p4-recollection-${sha256(
        `${snapshot.snapshotId}|${candidate.recollectionId}`,
      ).slice(0, 16)}`,
      source: {
        schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
        sourceSchemaId: RECOLLECTION_SOURCE_SCHEMA_ID,
        sourceId: snapshot.snapshotId,
        sourceRevision: snapshot.revision,
        sourceHash: snapshot.snapshotHash,
      },
      semanticSchemaId: RECOLLECTION_SEMANTIC_SCHEMA_ID,
      semanticContent,
    };
  }

  /** unavailable → 显式 marker unit（不伪装空）。 */
  private unavailableUnit(snapshot: RecollectionSnapshot): P0P1P2P3P4Unit {
    const reason = snapshot.unavailableReason ?? "memory service unavailable";
    const semanticContent: JsonValue = {
      schemaId: RECOLLECTION_SEMANTIC_SCHEMA_ID,
      status: "unavailable",
      unavailableReason: reason,
    };
    return {
      contextUnitId: `p4-recollection-unavailable-${sha256(snapshot.snapshotId).slice(0, 16)}`,
      source: {
        schemaId: CONTEXT_UNIT_SOURCE_REF_V1_SCHEMA_ID,
        sourceSchemaId: RECOLLECTION_SOURCE_SCHEMA_ID,
        sourceId: snapshot.snapshotId,
        sourceRevision: snapshot.revision,
        sourceHash: snapshot.snapshotHash,
      },
      semanticSchemaId: RECOLLECTION_SEMANTIC_SCHEMA_ID,
      semanticContent,
    };
  }
}
