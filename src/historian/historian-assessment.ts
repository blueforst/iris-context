/**
 * R3 Historian 模块移植说明（R3-P0 port）：
 *
 * 本文件从已通过审查的 `agent/r2-product-parity-fix-r3-historian` 分支
 * （commit 5b94db7，R3 v13 对齐实现 B1–B8）原样移植到 main，作为 R3
 * Historian 子系统的基座（issue #8 Phase B）。代码逻辑与分支保持逐字节一致；
 * 所有针对 main 依赖集的适配点均以内联中文注释（"移植说明/R3-P0"）标注。
 * 后续 R3-P1..P4 工作项负责对齐 v13 规格的增量（ContextHistoryReadPort
 * m0-clamp 等）。
 */
import { createHash } from "node:crypto";

import type { EvidenceSet } from "./historian-compartment.js";

/**
 * R3 MemoryAssessmentDelta + recall projection boundary
 * (issue #8 Phase B Feature B7).
 *
 * The Historian consumes the persisted InvocationMemoryRecallProjection
 * through a NARROW read-only port:
 *  - ONLY memoryRefs that appear in the recall projection can become
 *    assessment targets;
 *  - the basis MUST come from this Publication's NEW raw Evidence (the
 *    evidence sets committed in the SAME transaction);
 *  - assessment IDs are deterministic;
 *  - relations: supports / contradicts / supersedes / retracts / qualifies /
 *    uncertain / no_change;
 *  - the Historian NEVER modifies Graphiti, RecallDisposition, or old
 *    Evidence;
 *  - no assessment when there is insufficient lineage/basis;
 *  - repeated recalls are NOT counted as multiple evidence.
 *
 * Boundaries: this repo NEVER implements a Memory Router, stable memoryRef
 * resolution, or reads the iris-memory data root. The recall projection is
 * an in-repo DTO produced upstream (the Memory Client boundary) and
 * consumed here read-only.
 */

export type AssessmentRelation =
  "supports" | "contradicts" | "supersedes" | "retracts" | "qualifies" | "uncertain" | "no_change";

export type AssessmentRationaleCode =
  | "new_evidence_supports"
  | "new_evidence_contradicts"
  | "recall_superseded"
  | "recall_retracted"
  | "recall_qualified"
  | "insufficient_lineage"
  | "no_change_observed";

/** Narrow read-only recall projection (one invocation's recalled cards). */
export interface InvocationMemoryRecallProjection {
  invocationId: string;
  runtimeSessionId: string;
  /** memoryRefs recalled for this invocation (deduplicated). */
  memoryRefs: string[];
  /** Optional per-ref recall count (repeat recalls are NOT multiple
   * evidence — only presence matters). */
  recallCounts?: Record<string, number>;
}

export interface MemoryAssessmentDelta {
  assessmentId: string;
  publicationSequence: number;
  runtimeSessionId: string;
  targetMemoryRef: string;
  /** Invocation ids in which the recall occurred (deduplicated). */
  observedInInvocationIds: string[];
  relation: AssessmentRelation;
  /** Evidence sets from THIS publication that form the basis. */
  basisEvidenceSetIds: string[];
  assessmentConfidence: number;
  suggestedRecallDisposition: string | null;
  rationaleCode: AssessmentRationaleCode;
}

export interface AssessmentInput {
  runtimeSessionId: string;
  publicationSequence: number;
  /** The NEW raw evidence sets committed in this publication. */
  newEvidenceSets: EvidenceSet[];
  /** The recall projection for the invocation(s) being assessed. */
  recallProjections: InvocationMemoryRecallProjection[];
  nowMs?: () => number;
}

/** Deterministic assessment ID (publication + target + first invocation). */
export function assessmentId(
  runtimeSessionId: string,
  publicationSequence: number,
  targetMemoryRef: string,
): string {
  return createHash("sha256")
    .update(`${runtimeSessionId}:${publicationSequence}:${targetMemoryRef}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Derive MemoryAssessmentDeltas for the recall targets. PURE decision
 * (the caller persists them in the B5 transaction):
 *  - target must be in a recall projection (otherwise skipped);
 *  - repeated recalls across invocations are deduplicated (recallCounts
 *    never inflate the basis);
 *  - no basis evidence from THIS publication → insufficient_lineage (no
 *    assessment with a fabricated basis).
 */
export function deriveMemoryAssessments(input: AssessmentInput): MemoryAssessmentDelta[] {
  const { runtimeSessionId, publicationSequence, newEvidenceSets, recallProjections } = input;

  // Deduplicated recall targets (a target recalled in ANY projection is a
  // candidate; repeated recalls are NOT multiple evidence).
  const targets = new Map<string, string[]>();
  for (const projection of recallProjections) {
    for (const memoryRef of projection.memoryRefs) {
      const invocations = targets.get(memoryRef) ?? [];
      if (!invocations.includes(projection.invocationId)) {
        invocations.push(projection.invocationId);
      }
      targets.set(memoryRef, invocations);
    }
  }

  // Evidence from THIS publication only (never old Evidence).
  const evidenceText = newEvidenceSets
    .map((set) => set.entries.map((entry) => JSON.stringify(entry.payload)).join("\n"))
    .join("\n");

  const deltas: MemoryAssessmentDelta[] = [];
  for (const [memoryRef, invocations] of targets) {
    const delta = assessTarget({
      runtimeSessionId,
      publicationSequence,
      targetMemoryRef: memoryRef,
      observedInInvocationIds: invocations,
      newEvidenceSets,
      evidenceText,
    });
    if (delta !== null) {
      deltas.push(delta);
    }
  }
  return deltas;
}

function assessTarget(input: {
  runtimeSessionId: string;
  publicationSequence: number;
  targetMemoryRef: string;
  observedInInvocationIds: string[];
  newEvidenceSets: EvidenceSet[];
  evidenceText: string;
}): MemoryAssessmentDelta | null {
  const {
    runtimeSessionId,
    publicationSequence,
    targetMemoryRef,
    observedInInvocationIds,
    newEvidenceSets,
    evidenceText,
  } = input;

  // No basis from THIS publication → insufficient lineage (no assessment).
  if (newEvidenceSets.length === 0 || evidenceText.trim().length === 0) {
    return null;
  }

  const basisEvidenceSetIds = newEvidenceSets.map((set) => set.evidenceSetId);
  const lower = evidenceText.toLowerCase();
  const refLower = targetMemoryRef.toLowerCase();
  // The recall target is "mentioned" when the evidence text contains a
  // substantive token of the ref (strip a common "memory-ref-" prefix, then
  // match the longest token ≥ 4 chars). A pure prefix slice would not match
  // "memory-ref-deployment" against "the deployment plan".
  const refTokens = refLower
    .replace(/^memory[-_]?ref[-_:]?/, "")
    .split(/[-_:/.]+/)
    .filter((token) => token.length >= 4);
  const refMentioned =
    refTokens.length > 0
      ? refTokens.some((token) => lower.includes(token))
      : lower.includes(refLower.slice(0, 8));

  let relation: AssessmentRelation;
  let rationaleCode: AssessmentRationaleCode;
  let confidence: number;
  let disposition: string | null;

  if (!refMentioned) {
    // The recall target was NOT addressed by this publication's new
    // evidence → no_change observed (not fabricated support/contradiction).
    relation = "no_change";
    rationaleCode = "no_change_observed";
    confidence = 0.2;
    disposition = null;
  } else if (/contradict|wrong|incorrect|not true|disagree/i.test(lower)) {
    relation = "contradicts";
    rationaleCode = "new_evidence_contradicts";
    confidence = 0.8;
    disposition = "challenged";
  } else if (/supersede|replac|outdated|obsolete/i.test(lower)) {
    relation = "supersedes";
    rationaleCode = "recall_superseded";
    confidence = 0.75;
    disposition = "superseded";
  } else if (/retract|take back|recant/i.test(lower)) {
    relation = "retracts";
    rationaleCode = "recall_retracted";
    confidence = 0.75;
    disposition = "retracted";
  } else if (/qualif|except|however|but only/i.test(lower)) {
    relation = "qualifies";
    rationaleCode = "recall_qualified";
    confidence = 0.6;
    disposition = null;
  } else if (/support|confirm|agree|correct|yes/i.test(lower)) {
    relation = "supports";
    rationaleCode = "new_evidence_supports";
    confidence = 0.7;
    disposition = null;
  } else {
    // The target is mentioned but no clear relation → uncertain.
    relation = "uncertain";
    rationaleCode = "insufficient_lineage";
    confidence = 0.4;
    disposition = null;
  }

  return {
    assessmentId: assessmentId(runtimeSessionId, publicationSequence, targetMemoryRef),
    publicationSequence,
    runtimeSessionId,
    targetMemoryRef,
    observedInInvocationIds,
    relation,
    basisEvidenceSetIds,
    assessmentConfidence: confidence,
    suggestedRecallDisposition: disposition,
    rationaleCode,
  };
}
