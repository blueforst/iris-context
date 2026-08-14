/**
 * Historian compartments（CompartmentRevision）—— Phase D，lineage-scoped。
 *
 * v29：Historian 提交 Compartments 后，Context 将其作为 P3 authoritative
 * source 接收。每个 compartment 是不可变语义容器，覆盖 lineage 内一段
 * 连续、已提交的 contextSeq 窗口；身份为 lineage-scoped
 * `compartment-{lineageId}-{compartmentSequence}`（不再嵌入 runtime session）。
 *
 * 坐标全部为 contextSeq；entrySeq 只在 attribution 面出现（本模块不再消费
 * Pi Session wire）。episodeType 枚举不再包含 continuity_transition（v27 废止
 * ContinuitySnapshot/wrapup）。
 *
 * 不变量（纯构造，调用方在事务内 commit）：
 *  - content 只来自已验证的 committed ContextMessageUnitV1（批量成员）；
 *  - start/end/sourceRangeHash 由同一批单元推导（contextSeq 坐标）；
 *  - attribution 区分 user / external_document / tool_observation / iris_decision；
 *  - anti-echo：evidenceBasis 只含 include 且非 derived-only 的单元；
 *    derived-only 批标记为 derivedOnly，不产生新 evidence。
 */

import { createHash } from "node:crypto";

import type { ContextMessageUnitV1 } from "../contracts/context-v27.js";
import type { EvidenceBasisRefV1 } from "../contracts/memory-publication.js";
import { classifyEvidenceBasis, unitViewOf, type HistorianUnitView } from "./anti-echo.js";

/** OpenCode taxonomy（B4）。 */
export type CompartmentImportance = "low" | "medium" | "high" | "critical";
/** v27 后：无 continuity_transition。 */
export type CompartmentEpisodeType = "request_response" | "tool_execution" | "maintenance";

export interface Attribution {
  role: "user" | "external_document" | "tool_observation" | "iris_decision";
  contextUnitIds: string[];
}

/** 不可变 CompartmentRevision（historian.db `compartments` 一行）。 */
export interface HistoricalCompartment {
  compartmentId: string;
  /** lineage-scoped 身份（P3 read port 的 VALUE）。 */
  lineageId: string;
  /** runtime session 仅作 attribution（可为空字符串）。 */
  runtimeSessionId: string;
  /** lineage-scoped compartment sequence（1-based，单调）。 */
  compartmentSequence: number;
  startContextSeq: number;
  endContextSeq: number;
  sourceRangeHash: string;
  content: string;
  p1: string;
  p2: string;
  p3: string;
  p4: string;
  importance: CompartmentImportance;
  episodeType: CompartmentEpisodeType;
  attributionManifestId: string;
  /** 提交该 compartment 的 publication sequence（B5 填充）。 */
  publicationSequence?: number;
}

/** 每个 compartment 的 attribution provenance（roles 保持区分）。 */
export interface AttributionManifest {
  attributionManifestId: string;
  lineageId: string;
  compartmentId: string;
  attributions: Attribution[];
}

export interface BuildCompartmentInput {
  lineageId: string;
  /** attribution（可为空字符串）。 */
  runtimeSessionId: string;
  compartmentSequence: number;
  /** 已提交、已验证的 eligible 单元（批量成员，升序 contextSeq）。 */
  units: ContextMessageUnitV1[];
  estimateTokens?: (text: string) => number;
}

export interface BuiltCompartment {
  compartment: HistoricalCompartment;
  attributionManifest: AttributionManifest;
  /** Token estimate of the compartment content (deterministic). */
  estimatedTokens: number;
  /** anti-echo：本批的 evidence basis（只含 eligible 单元）。 */
  evidenceBasis: EvidenceBasisRefV1[];
  /** anti-echo：本批是否 derived-only（无任何新 basis）。 */
  derivedOnly: boolean;
}

/** Deterministic sha256（contextSeq 坐标）。 */
export function compartmentRangeHash(input: {
  lineageId: string;
  fromContextSeq: number;
  throughContextSeq: number;
  units: ReadonlyArray<Pick<ContextMessageUnitV1, "contextSeq" | "contextUnitId" | "contentHash">>;
}): string {
  const body = input.units
    .map((unit) => `${unit.contextSeq}:${unit.contextUnitId}:${unit.contentHash}`)
    .join("\n");
  return createHash("sha256")
    .update(`${input.lineageId}|${input.fromContextSeq}|${input.throughContextSeq}|${body}`, "utf8")
    .digest("hex");
}

/**
 * Canonical provider-visible semantic text for a ContextMessageUnitV1
 * （B4 content source —— 与 Context pipeline 同一渲染 basis；工具内部与
 * companion 元数据永不渲染）。
 */
export function renderUnitProviderText(unit: ContextMessageUnitV1): string {
  const content = unit.semanticContent;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => renderPart(part))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    const body = record["content"];
    if (typeof body === "string") {
      return body;
    }
    if (Array.isArray(body)) {
      return body
        .map((part) => renderPart(part))
        .filter((text) => text.length > 0)
        .join("\n");
    }
  }
  return JSON.stringify(content);
}

function renderPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (typeof part !== "object" || part === null) {
    return "";
  }
  const record = part as Record<string, unknown>;
  if (record["type"] === "text" && typeof record["text"] === "string") {
    return record["text"];
  }
  if (record["type"] === "toolCall") {
    const name = typeof record["name"] === "string" ? record["name"] : "unknown";
    const args = record["arguments"];
    return `TOOL CALL: ${name}(${typeof args === "string" ? args : JSON.stringify(args ?? {})})`;
  }
  return "";
}

/** unit kind → attribution role（保持区分，永不猜测）。 */
function attributionRoleFor(unit: ContextMessageUnitV1): Attribution["role"] {
  switch (unit.kind) {
    case "user":
      return "user";
    case "assistant":
      return "iris_decision";
    case "tool_call":
      return "iris_decision";
    case "tool_result":
      return "tool_observation";
    case "body_event":
      return "external_document";
    case "operational":
      return "external_document";
  }
}

/** 构建一个不可变 CompartmentRevision（纯；调用方在事务内 commit）。 */
export function buildCompartment(input: BuildCompartmentInput): BuiltCompartment | null {
  const { lineageId, runtimeSessionId, compartmentSequence, units } = input;
  if (units.length === 0) {
    return null;
  }
  const first = units[0];
  const last = units[units.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  const startContextSeq = first.contextSeq;
  const endContextSeq = last.contextSeq;

  const contentParts: string[] = [];
  const attributions = new Map<Attribution["role"], string[]>();
  for (const unit of units) {
    const text = renderUnitProviderText(unit);
    if (text.length > 0) {
      contentParts.push(text);
    }
    const role = attributionRoleFor(unit);
    const existing = attributions.get(role) ?? [];
    existing.push(unit.contextUnitId);
    attributions.set(role, existing);
  }
  const content = contentParts.join("\n");
  const sourceRangeHash = compartmentRangeHash({
    lineageId,
    fromContextSeq: startContextSeq,
    throughContextSeq: endContextSeq,
    units,
  });

  // OpenCode p1..p4 taxonomy（确定性提取，无 LLM）。
  const p1 = summarizePrimary(content);
  const p2 = summarizeSecondary(content);
  const p3 = extractDecisions(content);
  const p4 = extractOpenThreads(content);
  const importance = deriveImportance(content, units);
  const episodeType = deriveEpisodeType(units);

  const compartmentId = `compartment-${lineageId}-${compartmentSequence}`;
  const attributionManifestId = `am-${lineageId}-${compartmentSequence}`;

  const manifest: AttributionManifest = {
    attributionManifestId,
    lineageId,
    compartmentId,
    attributions: [...attributions.entries()].map(([role, contextUnitIds]) => ({
      role,
      contextUnitIds,
    })),
  };

  // anti-echo（provider-neutral）：evidenceBasis 只含 include 且非 derived-only
  // 的单元；derivedOnly = 本批无任何新 basis。
  const unitViews: HistorianUnitView[] = units.map((unit) => unitViewOf(lineageId, unit));
  const classified = classifyEvidenceBasis(lineageId, unitViews);

  const estimatedTokens = input.estimateTokens?.(content) ?? Math.ceil(content.length / 4);

  return {
    compartment: {
      compartmentId,
      lineageId,
      runtimeSessionId,
      compartmentSequence,
      startContextSeq,
      endContextSeq,
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
    attributionManifest: manifest,
    estimatedTokens,
    evidenceBasis: classified.evidenceBasis,
    derivedOnly: classified.derivedOnly,
  };
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

function deriveImportance(content: string, units: ContextMessageUnitV1[]): CompartmentImportance {
  const toolResults = units.filter((unit) => unit.kind === "tool_result").length;
  const userMessages = units.filter((unit) => unit.kind === "user").length;
  if (toolResults >= 3 || content.length > 8000) return "high";
  if (userMessages >= 2 || content.length > 3000) return "medium";
  return "low";
}

function deriveEpisodeType(units: ContextMessageUnitV1[]): CompartmentEpisodeType {
  const hasTool = units.some((unit) => unit.kind === "tool_result");
  const hasUser = units.some((unit) => unit.kind === "user");
  if (hasTool) return "tool_execution";
  if (hasUser) return "request_response";
  return "maintenance";
}
