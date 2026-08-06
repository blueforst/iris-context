import type { AgentRuntimePhase } from "./runtime-ports.js";
import type { AgentInput } from "./origin.js";
import type { ToolDescriptor } from "./tool.js";

export type AgentRuntimeEvent =
  | { type: "turn_start"; invocationId: string }
  | { type: "message_delta"; invocationId: string; text: string }
  | { type: "tool_call"; invocationId: string; toolCallId: string; toolName: string }
  | { type: "tool_result"; invocationId: string; toolCallId: string; toolName: string }
  | { type: "settled"; invocationId: string; nextTurnCount: number }
  | { type: "failed"; invocationId: string; code: string };

export interface AgentRuntimePort {
  prompt(input: AgentInput): AsyncIterable<AgentRuntimeEvent>;
  abort(invocationId: string, reason?: string): Promise<void>;
  getPhase(): AgentRuntimePhase;
}

export interface HistorianPublicationOutboxPort {
  claimBatch(input: {
    batchSize: number;
  }): Promise<Array<{ publicationId: string; payloadHash: string }>>;
  markDelivered(input: { publicationId: string; receiptHash: string }): Promise<void>;
  markFailed(input: { publicationId: string; errorCode: string }): Promise<void>;
}

export interface MemoryRecallPort {
  recall(
    query: string,
    options?: { limit?: number; asOf?: string },
  ): Promise<{ cards: unknown[]; status: string }>;
}

export interface MemoryExpansionPort {
  expand(input: {
    memoryRef: string;
    mode: "summary" | "provenance" | "evidence";
  }): Promise<unknown>;
}

export interface MemoryHealthPort {
  health(): Promise<{ status: string; contractVersion: string; capabilities: string[] }>;
}

export interface ToolCatalogPort {
  getProcessCatalog(): Promise<{ catalogVersion: string; descriptors: ToolDescriptor[] }>;
  getByName(name: string): Promise<ToolDescriptor | undefined>;
}

export interface ToolExecutionPort {
  execute(call: { toolCallId: string; toolName: string; args: Record<string, unknown> }): Promise<{
    content: unknown[];
    details: Record<string, unknown>;
    isError: boolean;
  }>;
}

/**
 * R4 (iris_agent#9):Memory Client —— 投递 Historian publication 到
 * iris_memory 并接收 durable acceptance receipt。Agent 只经此窄端口
 * 与 memory 服务交互(不读其数据库、不连接 Neo4j)。
 */
export type PublicationDeliveryOutcome =
  | { ok: true; receiptHash: string }
  | { ok: false; error: "rejected" | "unavailable" | `http_${number}` };

export interface MemoryClientPort {
  deliverPublication(publication: unknown): Promise<PublicationDeliveryOutcome>;
}
