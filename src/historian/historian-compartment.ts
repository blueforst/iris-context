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

import type { HistorianBoundarySnapshot, SequencedSessionEntry } from "../contracts/historian.js";
import {
  classifyEvidenceBasis,
  type EvidenceBasisRef,
  type HistorianUnitView,
} from "./anti-echo.js";
import type { ProvisionalUnit, HistorianAnalysisView } from "./historian-analysis.js";

/**
 * R3 Historian compartments / segments / evidence / attribution
 * (issue #8 Phase B Feature B4).
 *
 * IMMUTABLE semantic containers built from VERIFIED projection units only:
 *  - HistoricalCompartment : a bounded, contiguous entry range with an
 *    OpenCode p1/p2/p3/p4/importance/episodeType taxonomy, a session-local
 *    compartment sequence, and a source range/hash/cursor invariant;
 *  - HistorianSegment      : a sub-range WITHIN a compartment (contiguous);
 *  - EvidenceSet           : the RAW entries an attribution/assessment is
 *    based on — summaries/recall text can NEVER masquerade as evidence;
 *  - AttributionManifest   : per-compartment provenance distinguishing
 *    user / external document / tool observation / Iris decision.
 *
 * Invariants enforced here (pure construction — the caller commits):
 *  - content comes ONLY from validated projection units (the analysis view
 *    was built from entries the runner already range-validated in B3);
 *  - start/end/range hash are derived from the SAME source entries;
 *  - a compartment never crosses the protected tail seam;
 *  - attribution keeps user/doc/tool/Iris roles distinct;
 *  - summaries and recall text are NEVER stored as EvidenceSet entries.
 */

/** OpenCode taxonomy (B4). */
export type CompartmentImportance = "low" | "medium" | "high" | "critical";
export type CompartmentEpisodeType =
  "request_response" | "tool_execution" | "continuity_transition" | "maintenance";

export interface Attribution {
  role: "user" | "external_document" | "tool_observation" | "iris_decision";
  entryIds: string[];
}

/** Immutable compartment (one row in `compartments`). */
export interface HistoricalCompartment {
  compartmentId: string;
  runtimeSessionId: string;
  /** Session-local compartment sequence (1-based, monotonic). */
  compartmentSequence: number;
  startEntrySeq: number;
  endEntrySeq: number;
  sourceRangeHash: string;
  /** Canonical provider-visible semantic content (from projection units). */
  content: string;
  p1: string; // primary summary
  p2: string; // secondary detail
  p3: string; // decisions/commitments
  p4: string; // open threads/risks
  importance: CompartmentImportance;
  episodeType: CompartmentEpisodeType;
  attributionManifestId: string;
  /** The publication sequence that committed this compartment (B5 fills it). */
  publicationSequence?: number;
}

/** Immutable segment within a compartment. */
export interface HistorianSegment {
  segmentId: string;
  compartmentId: string;
  runtimeSessionId: string;
  startEntrySeq: number;
  endEntrySeq: number;
  sourceRangeHash: string;
  content: string;
  attributionManifestId: string;
}

/** Immutable raw evidence (NEVER a summary/recall paraphrase). */
export interface EvidenceSet {
  evidenceSetId: string;
  runtimeSessionId: string;
  compartmentId: string;
  startEntrySeq: number;
  endEntrySeq: number;
  sourceRangeHash: string;
  /** Serialized RAW entries (identity-preserving; user/doc/tool verbatim). */
  entries: Array<{
    entrySeq: number;
    entryId: string;
    role: "user" | "assistant" | "toolResult" | "custom" | "other";
    payload: unknown;
  }>;
  /**
   * R3 (anti-echo)：仅 disposition=include 且非 derived-only 的 Context
   * 单元作为新 Evidence 的 basis。缺省（旧路径未提供单元视图）为 undefined。
   */
  evidenceBasis?: EvidenceBasisRef[];
  /** R3 (anti-echo)：本 evidence 是否 derived-only（无任何新 basis）。 */
  derivedOnly?: boolean;
}

/** Attribution manifest for a compartment (roles distinguished). */
export interface AttributionManifest {
  attributionManifestId: string;
  runtimeSessionId: string;
  compartmentId: string;
  attributions: Attribution[];
}

export interface BuildCompartmentInput {
  runtimeSessionId: string;
  compartmentSequence: number;
  boundary: HistorianBoundarySnapshot;
  /** The VERIFIED eligible entries the runner already range-validated. */
  eligibleEntries: SequencedSessionEntry[];
  analysis: HistorianAnalysisView;
  /** The safe commit range (from the B3 validation outcome). */
  commitThroughEntrySeq: number;
  estimateTokens?: (text: string) => number;
  /**
   * R3 (anti-echo)：本批 Context 单元窄视图（values-only）。提供时在
   * EvidenceSet 上计算 evidenceBasis/derivedOnly；缺省保持旧行为。
   */
  unitViews?: HistorianUnitView[];
}

export interface BuiltCompartment {
  compartment: HistoricalCompartment;
  segments: HistorianSegment[];
  evidence: EvidenceSet;
  attributionManifest: AttributionManifest;
  /** Token estimate of the compartment content (deterministic). */
  estimatedTokens: number;
}

/** Deterministic sha256 (order-insensitive-safe over a stable string). */
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Raw-role of a sequenced entry (identity-preserving). */
function rawRole(entry: SequencedSessionEntry): EvidenceSet["entries"][number]["role"] {
  const candidate = entry.entry as {
    type?: string;
    message?: { role?: string };
  };
  const message = candidate?.message;
  if (message?.role === "user") return "user";
  if (message?.role === "assistant") return "assistant";
  if (message?.role === "toolResult") return "toolResult";
  if (candidate?.type === "custom_message") return "custom";
  return "other";
}

/** Group a range of verified units into a compartment (pure). */
export function buildCompartment(input: BuildCompartmentInput): BuiltCompartment | null {
  const {
    runtimeSessionId,
    compartmentSequence,
    boundary,
    eligibleEntries,
    commitThroughEntrySeq,
  } = input;

  // The compartment NEVER crosses the frozen protected tail seam or the
  // validated commit ceiling (invariant: source range is bounded). The
  // commitThrough is CLAMPED to the frozen eligibleThrough — the builder
  // never widens the range even if a caller passes a larger ceiling.
  const safeCommitThrough = Math.min(commitThroughEntrySeq, boundary.eligibleThroughEntrySeq);
  const rangeEntries = eligibleEntries.filter(
    (e) => e.entrySeq >= (eligibleEntries[0]?.entrySeq ?? 1) && e.entrySeq <= safeCommitThrough,
  );
  if (rangeEntries.length === 0) {
    return null;
  }
  const startEntrySeq = rangeEntries[0]?.entrySeq ?? 0;
  const endEntrySeq = rangeEntries[rangeEntries.length - 1]?.entrySeq ?? 0;
  if (endEntrySeq > boundary.eligibleThroughEntrySeq) {
    return null; // defensive: never exceed the frozen boundary
  }

  // Content = canonical provider-visible semantics from the verified units
  // (the SAME rendering basis the Context pipeline uses — never raw entry
  // JSON in the semantic content; raw bytes live in the EvidenceSet only).
  const unitBySeq = new Map<number, ProvisionalUnit>();
  for (const unit of input.analysis.units) {
    unitBySeq.set(unit.entrySeq, unit);
  }
  const contentParts: string[] = [];
  const rawEntries: EvidenceSet["entries"] = [];
  const attributions = new Map<Attribution["role"], string[]>();

  for (const entry of rangeEntries) {
    const unit = unitBySeq.get(entry.entrySeq);
    const role = rawRole(entry);
    // Content comes ONLY from projection units that are safe to narrate;
    // the unit's providerVisible text IS the semantic content.
    if (unit !== undefined && unit.kind !== "other") {
      const text = unit.providerVisible;
      if (text.length > 0) {
        contentParts.push(text);
      }
    }
    rawEntries.push({
      entrySeq: entry.entrySeq,
      entryId: entry.entryId,
      role,
      payload: entry.entry,
    });
    // Attribution roles stay distinct (user/doc/tool/decision).
    const attributionRole = attributionRoleFor(role, unit);
    const existing = attributions.get(attributionRole) ?? [];
    existing.push(entry.entryId);
    attributions.set(attributionRole, existing);
  }

  const content = contentParts.join("\n");
  const sourceRangeHash = hash(
    `${runtimeSessionId}:${startEntrySeq}:${endEntrySeq}:${rangeEntries.map((e) => e.contentHash).join(";")}`,
  );

  // OpenCode p1..p4 taxonomy (deterministic extraction, no LLM here).
  const p1 = summarizePrimary(content);
  const p2 = summarizeSecondary(content);
  const p3 = extractDecisions(content);
  const p4 = extractOpenThreads(content);
  const importance = deriveImportance(content, rawEntries);
  const episodeType = deriveEpisodeType(rawEntries);

  const attributionManifestId = `am-${runtimeSessionId}-${compartmentSequence}`;
  const compartmentId = `compartment-${runtimeSessionId}-${compartmentSequence}`;

  const manifest: AttributionManifest = {
    attributionManifestId,
    runtimeSessionId,
    compartmentId,
    attributions: [...attributions.entries()].map(([role, entryIds]) => ({ role, entryIds })),
  };

  // R3 (anti-echo)：当调用方提供 Context 单元视图时，计算 evidenceBasis
  // 与 derivedOnly（仅 include 且非 derived-only 的单元成为新 Evidence
  // basis；reference_only/exclude/回显不进入）。缺省 → 旧行为不变。
  let evidenceBasis: EvidenceBasisRef[] | undefined;
  let derivedOnly: boolean | undefined;
  if (input.unitViews !== undefined && input.unitViews.length > 0) {
    const classified = classifyEvidenceBasis(input.unitViews);
    evidenceBasis = classified.evidenceBasis;
    derivedOnly = classified.derivedOnly;
  }

  const evidence: EvidenceSet = {
    evidenceSetId: `evidence-${runtimeSessionId}-${compartmentSequence}`,
    runtimeSessionId,
    compartmentId,
    startEntrySeq,
    endEntrySeq,
    sourceRangeHash,
    entries: rawEntries,
    ...(evidenceBasis !== undefined ? { evidenceBasis } : {}),
    ...(derivedOnly !== undefined ? { derivedOnly } : {}),
  };

  // One segment PER attribution role across the compartment range (content
  // stays role-scoped and immutable; start/end span the role's min/max
  // entrySeqs). The attribution manifest is the authoritative provenance;
  // segments are derived groupings for recall/projection.
  const segments: HistorianSegment[] = [];
  for (const attribution of manifest.attributions) {
    const ids = new Set(attribution.entryIds);
    const segEntries = rangeEntries.filter((e) => ids.has(e.entryId));
    if (segEntries.length === 0) {
      continue;
    }
    const segText = segEntries
      .map((e) => unitBySeq.get(e.entrySeq)?.providerVisible ?? "")
      .filter((text) => text.length > 0)
      .join("\n");
    segments.push({
      segmentId: `segment-${runtimeSessionId}-${compartmentSequence}-${segments.length + 1}`,
      compartmentId,
      runtimeSessionId,
      startEntrySeq: segEntries[0]?.entrySeq ?? 0,
      endEntrySeq: segEntries[segEntries.length - 1]?.entrySeq ?? 0,
      sourceRangeHash: hash(
        `${runtimeSessionId}:${segEntries[0]?.entrySeq ?? 0}:${segEntries[segEntries.length - 1]?.entrySeq ?? 0}:${segEntries.map((e) => e.contentHash).join(";")}`,
      ),
      content: segText,
      attributionManifestId,
    });
  }

  const estimatedTokens = input.estimateTokens?.(content) ?? Math.ceil(content.length / 4);

  return {
    compartment: {
      compartmentId,
      runtimeSessionId,
      compartmentSequence,
      startEntrySeq,
      endEntrySeq,
      sourceRangeHash,
      content,
      p1,
      p2,
      p3,
      p4,
      importance,
      episodeType,
      attributionManifestId,
    },
    segments,
    evidence,
    attributionManifest: manifest,
    estimatedTokens,
  };
}

function attributionRoleFor(
  role: EvidenceSet["entries"][number]["role"],
  unit: ProvisionalUnit | undefined,
): Attribution["role"] {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "iris_decision";
    case "toolResult":
      return "tool_observation";
    case "custom":
      // A custom_message with an origin (e.g. an external doc ingestion)
      // is an external document; the input companion is user-provenance.
      return unit?.kind === "custom" ? "external_document" : "user";
    default:
      return unit?.kind === "user_input" ? "user" : "iris_decision";
  }
}

/** Deterministic stable serialization of a raw entry payload. */
export function serializeEntryPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload);
}

function summarizePrimary(content: string): string {
  if (content.length === 0) {
    return "";
  }
  return content.slice(0, 400);
}

function summarizeSecondary(content: string): string {
  if (content.length <= 400) {
    return "";
  }
  return content.slice(400, 1200);
}

function extractDecisions(content: string): string {
  // Deterministic heuristic: lines referencing commitments/decisions.
  const lines = content.split("\n");
  const decisions = lines.filter((line) => /decision|commit|will |decide|agreed/i.test(line));
  return decisions.join("\n");
}

function extractOpenThreads(content: string): string {
  const lines = content.split("\n");
  const threads = lines.filter((line) =>
    /open|pending|next step|follow.?up|todo|blocked/i.test(line),
  );
  return threads.join("\n");
}

function deriveImportance(content: string, entries: EvidenceSet["entries"]): CompartmentImportance {
  const toolCalls = entries.filter((e) => e.role === "toolResult").length;
  const userMessages = entries.filter((e) => e.role === "user").length;
  if (toolCalls >= 3 || content.length > 8000) return "high";
  if (userMessages >= 2 || content.length > 3000) return "medium";
  return "low";
}

function deriveEpisodeType(entries: EvidenceSet["entries"]): CompartmentEpisodeType {
  const hasTool = entries.some((e) => e.role === "toolResult");
  const hasUser = entries.some((e) => e.role === "user");
  if (hasTool) return "tool_execution";
  if (hasUser) return "request_response";
  return "maintenance";
}
