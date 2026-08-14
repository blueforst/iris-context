/**
 * Phase D test helper: ContextHistoryReadPort stub —— 从可变的
 * ContextMessageUnitV1[] fixture 提供 claim/freeze/list 视图。
 *
 * 权威边界（v29）：Historian 的唯一正常语义输入是 Context 冻结的
 * HistorianBatchV1（lineage + 全局 contextSeq）。本 stub 模拟
 * ContextHistoryReadPort 的 VALUE 视图（不持有 context.db）。
 */
import {
  estimateSemanticTokens,
  historianBatchRangeHash,
  newBatchIdentity,
  newClaimId,
  type HistorianBatchV1,
} from "../../src/contracts/historian.js";
import type { ContextMessageUnitV1 } from "../../src/contracts/context-v27.js";
import type { ContextHistoryReadPort } from "../../src/context/history-read-port.js";
import type { SemanticDerivationRefsV1 } from "../../src/contracts/context-v27.js";

export const STUB_LINEAGE_ID = "identity-stub";

export function emptyDerivationRefs(): SemanticDerivationRefsV1 {
  return { schemaId: "iris.semantic_derivation_refs.v1" };
}

/** 构造一条 fixture ContextMessageUnitV1（按全局 contextSeq 升序提供）。 */
export function fixtureUnit(input: {
  contextSeq: number;
  kind: ContextMessageUnitV1["kind"];
  semanticSchemaId: string;
  semanticContent: ContextMessageUnitV1["semanticContent"];
  historianDisposition?: ContextMessageUnitV1["historianDisposition"];
  derivationRefs?: SemanticDerivationRefsV1;
  rawArchiveRef?: ContextMessageUnitV1["rawArchiveRef"];
  contextUnitId?: string;
  createdAt?: string;
}): ContextMessageUnitV1 {
  return {
    schemaId: "iris.context_message_unit.v1",
    contextUnitId: input.contextUnitId ?? `unit-${input.contextSeq}`,
    contextLineageId: STUB_LINEAGE_ID,
    contextSeq: input.contextSeq,
    runtimeEventId: input.contextUnitId ?? `event-${input.contextSeq}`,
    kind: input.kind,
    semanticSchemaId: input.semanticSchemaId,
    semanticContent: input.semanticContent,
    historianDisposition: input.historianDisposition ?? "include",
    ...(input.derivationRefs !== undefined ? { derivationRefs: input.derivationRefs } : {}),
    ...(input.rawArchiveRef !== undefined ? { rawArchiveRef: input.rawArchiveRef } : {}),
    contentHash: `hash-${input.contextSeq}`,
    lifecycleState: "committed",
    createdAt:
      input.createdAt ?? new Date(Date.UTC(2026, 7, 1, 0, 0, input.contextSeq)).toISOString(),
  };
}

/** 常用 fixture：user + assistant（无派生引用）→ 非 derived-only。 */
export function simpleUnits(count = 3): ContextMessageUnitV1[] {
  const units: ContextMessageUnitV1[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    units.push(
      fixtureUnit({
        contextSeq: seq,
        kind: seq % 2 === 1 ? "user" : "assistant",
        semanticSchemaId:
          seq % 2 === 1
            ? "iris.semantic.context_message.user.v1"
            : "iris.semantic.context_message.assistant.v1",
        semanticContent: {
          role: seq % 2 === 1 ? "user" : "assistant",
          content: `message ${seq}`,
        },
      }),
    );
  }
  return units;
}

/**
 * 构建一个 ContextHistoryReadPort stub，从 fixture units 提供
 * claimHistorianBatch / freezeBatch（lineage + 全局 contextSeq）。
 */
export function createFixtureHistoryPort(options: {
  units?: () => ContextMessageUnitV1[];
  representedThroughContextSeq?: number;
  lineageId?: string;
}): ContextHistoryReadPort {
  const units = options.units ?? (() => []);
  const lineageId = options.lineageId ?? STUB_LINEAGE_ID;
  const claim = (
    afterContextSeqExclusive: number,
    throughContextSeqInclusive: number,
  ): HistorianBatchV1 => {
    const claimed = units().filter(
      (unit) =>
        unit.contextSeq > afterContextSeqExclusive && unit.contextSeq <= throughContextSeqInclusive,
    );
    const actualThrough =
      claimed.length === 0
        ? afterContextSeqExclusive
        : (claimed[claimed.length - 1]?.contextSeq ?? afterContextSeqExclusive);
    const fromContextSeq = afterContextSeqExclusive + 1;
    const batch: HistorianBatchV1 = {
      schemaId: "iris.historian_batch.v1",
      batchId: newBatchIdentity(lineageId, fromContextSeq, actualThrough),
      claimId: newClaimId(),
      contextLineageId: lineageId,
      fromContextSeq,
      throughContextSeq: actualThrough,
      rangeHash: "",
      semanticSchemaIds: [...new Set(claimed.map((unit) => unit.semanticSchemaId))],
      units: claimed,
      estimatedTokens: claimed.reduce(
        (total, unit) => total + estimateSemanticTokens(unit.semanticContent),
        0,
      ),
      frozenAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    batch.rangeHash = historianBatchRangeHash(batch);
    return batch;
  };
  return {
    getMaterializedBoundary() {
      return {
        representedThroughContextSeq: options.representedThroughContextSeq ?? 0,
        representedThroughEntrySeq: null,
        lineageStatus: "ok",
        providerProfileId: "mock",
      };
    },
    lineageId() {
      return lineageId;
    },
    listUnitsForHistorian(_lineageId, fromContextSeq, toContextSeq) {
      return units()
        .filter((unit) => unit.contextSeq >= fromContextSeq && unit.contextSeq <= toContextSeq)
        .map((unit) => ({
          contextUnitId: unit.contextUnitId,
          contextSeq: unit.contextSeq,
          runtimeEventId: unit.runtimeEventId,
          kind: unit.kind,
          historianDisposition: unit.historianDisposition,
          contentHash: unit.contentHash,
          derivationRefs: unit.derivationRefs ?? emptyDerivationRefs(),
          ...(unit.rawArchiveRef !== undefined ? { rawArchiveRef: unit.rawArchiveRef } : {}),
        }));
    },
    listUnitsWithPayload(_lineageId, fromContextSeq, toContextSeq) {
      return units()
        .filter((unit) => unit.contextSeq >= fromContextSeq && unit.contextSeq <= toContextSeq)
        .map((unit) => ({
          contextUnitId: unit.contextUnitId,
          contextSeq: unit.contextSeq,
          runtimeEventId: unit.runtimeEventId,
          kind: unit.kind,
          historianDisposition: unit.historianDisposition,
          contentHash: unit.contentHash,
          derivationRefs: unit.derivationRefs ?? emptyDerivationRefs(),
          payload: unit.semanticContent,
          payloadTimestamp: unit.createdAt,
        }));
    },
    claimHistorianBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      return claim(afterContextSeqExclusive, throughContextSeqInclusive);
    },
    freezeBatch({ afterContextSeqExclusive, throughContextSeqInclusive }) {
      return claim(afterContextSeqExclusive, throughContextSeqInclusive);
    },
  };
}
