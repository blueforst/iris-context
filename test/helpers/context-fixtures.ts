/**
 * 中性 Context 测试夹具（Phase C）：runtime-neutral RuntimeEventInput /
 * ContextStore / ContextIngest 共享构造。无任何 Pi 依赖。
 */
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeContentTextHash,
  type RuntimeEventCompanion,
  type RuntimeEventInput,
} from "../../src/contracts/runtime-events.js";
import type { CreateLineageInput } from "../../src/context/context-store.js";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "iris-context-test-"));
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 文件锁，忽略。
  }
}

/** 中性 direct user request origin。 */
export function userOrigin() {
  return {
    schemaId: "iris.origin_envelope.v1" as const,
    channel: "cli",
    principalKind: "user" as const,
    authority: "user_request" as const,
    trust: "limited" as const,
  };
}

export function makeLineageInput(sessionId: string, lineageId?: string): CreateLineageInput {
  return {
    ...(lineageId !== undefined ? { lineageId } : {}),
    runtimeSessionId: sessionId,
    providerProfileId: "mock",
    canonicalSystemPrompt: "system",
    systemProjectionHash: "sys-hash",
    preparedAt: "2026-08-05T00:00:00.000Z",
  };
}

/** 默认 companion 标记：pairKey 绑定 eventId，contentHash 覆盖 content（可验证）。 */
export function defaultCompanion(eventId: string, content: string): RuntimeEventCompanion {
  return { pairKey: `pk-${eventId}`, contentHash: computeContentTextHash(content) };
}

/**
 * user 主事件。默认**不带** companion 标记（双事件模型：配对由
 * `companionInput` 完成）；传 `companion` 走单事件表达（标记直接附在主事件上）。
 */
export function userInput(input: {
  eventId: string;
  content: string;
  sessionId?: string;
  companion?: RuntimeEventCompanion | false;
  timestamp?: number;
}): RuntimeEventInput {
  const companion = input.companion === false ? undefined : input.companion;
  return {
    eventId: input.eventId,
    kind: "user",
    runtimeSessionId: input.sessionId ?? "session-1",
    role: "user",
    payload: {
      role: "user",
      content: input.content,
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    },
    ...(companion !== undefined ? { companion } : {}),
    origin: userOrigin(),
    occurredAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: `user:${input.eventId}`,
  };
}

/**
 * companion 事件（双事件模型）：`companionOf` 指向主 user 事件；payload 为中性
 * CompanionPayloadV1（type 'iris_input_meta'）。kind 默认 operational。
 */
export function companionInput(input: {
  eventId: string;
  companionOf: string;
  pairKey?: string;
  contentHash?: string;
  layoutHash?: string;
  kind?: "user" | "operational";
  sessionId?: string;
}): RuntimeEventInput {
  return {
    eventId: input.eventId,
    kind: input.kind ?? "operational",
    runtimeSessionId: input.sessionId ?? "session-1",
    companionOf: input.companionOf,
    payload: {
      type: "iris_input_meta",
      pairKey: input.pairKey ?? `pk-${input.companionOf}`,
      ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
      ...(input.layoutHash !== undefined ? { layoutHash: input.layoutHash } : {}),
    },
    origin: userOrigin(),
    occurredAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: `companion:${input.eventId}`,
  };
}

export function assistantInput(input: {
  eventId: string;
  content: string;
  sessionId?: string;
}): RuntimeEventInput {
  return {
    eventId: input.eventId,
    kind: "assistant",
    runtimeSessionId: input.sessionId ?? "session-1",
    role: "assistant",
    payload: { role: "assistant", content: input.content, timestamp: 1 },
    origin: userOrigin(),
    occurredAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: `assistant:${input.eventId}`,
  };
}

export function toolResultInput(input: {
  eventId: string;
  text: string;
  toolCallId?: string;
  sessionId?: string;
}): RuntimeEventInput {
  return {
    eventId: input.eventId,
    kind: "tool_result",
    runtimeSessionId: input.sessionId ?? "session-1",
    role: "toolResult",
    payload: {
      role: "toolResult",
      toolCallId: input.toolCallId ?? `tool-${input.eventId}`,
      toolName: "echo",
      content: [{ type: "text", text: input.text }],
      isError: false,
      timestamp: 1,
    },
    origin: userOrigin(),
    occurredAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: `tool_result:${input.eventId}`,
  };
}

export function operationalInput(input: {
  eventId: string;
  sessionId?: string;
}): RuntimeEventInput {
  return {
    eventId: input.eventId,
    kind: "operational",
    runtimeSessionId: input.sessionId ?? "session-1",
    payload: { type: "runtime_recovery_notice", data: { notice: input.eventId } },
    origin: userOrigin(),
    occurredAt: "2026-08-05T00:00:00.000Z",
    idempotencyKey: `operational:${input.eventId}`,
  };
}
