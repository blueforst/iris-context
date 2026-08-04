import type { AgentMessage, CustomMessage } from "@earendil-works/pi-agent-core";

import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../contracts/context.js";
import type { ContextMessageUnit, ContextIngestPort } from "../contracts/context-units.js";
import type { RuntimeEventIngestPort } from "../contracts/runtime-events.js";
import {
  type IrisInputMetaDetails,
  decodeInputFrames,
  verifyCompanionLayoutHash,
} from "../runtime/companion.js";
import type { IrisBlockLayoutV1 } from "../contracts/tool.js";
import type { OriginEnvelope } from "../contracts/origin.js";

/**
 * R2-P0：ContextMessageUnit 的持久化端口（context.db，context_units 表）。
 */
export interface ContextUnitStorePort {
  hasUnitForEvent(eventId: string): boolean;
  insertUnit(unit: ContextMessageUnit): void;
  updateUnitPairing(
    runtimeSessionId: string,
    contextSeq: number,
    update: { companionEntryId: string; pairKey: string; paired: boolean; payload: AgentMessage },
  ): void;
  listUnits(
    runtimeSessionId: string,
    options?: { afterContextSeq?: number; limit?: number },
  ): ContextMessageUnit[];
  lastUnpairedInputSeq(runtimeSessionId: string): number | undefined;
  maxContextSeq(runtimeSessionId: string): number;
  close(): void;
}

function isInputMetaCompanion(message: AgentMessage): message is CustomMessage<unknown> {
  return (
    message.role === "custom" &&
    message.customType === IRIS_INPUT_META_CUSTOM_TYPE &&
    message.content === IRIS_INPUT_META_CONTENT &&
    message.display === false
  );
}

function authorityLabel(authority: OriginEnvelope["authority"]): string {
  switch (authority) {
    case "user_request":
      return "USER REQUEST";
    case "notice_only":
      return "NOTICE ONLY";
    case "data_only":
      return "DATA ONLY";
    case "internal_control":
      return "INTERNAL CONTROL";
  }
}

function sourceLabel(origin: OriginEnvelope): string {
  const kind = origin.principalKind.toUpperCase();
  const channel = origin.channel;
  return `[${kind} | ${channel} | ${authorityLabel(origin.authority)} | ${origin.trust.toUpperCase()}]`;
}

function frameOrigins(
  blocks: IrisBlockLayoutV1[] | undefined,
  frameCount: number,
): Array<OriginEnvelope | undefined> {
  if (!Array.isArray(blocks)) {
    return Array.from({ length: frameCount }, () => undefined);
  }
  const origins: Array<OriginEnvelope | undefined> = [];
  for (const block of blocks) {
    origins.push(block.sourceOrigin);
  }
  return origins;
}

/**
 * Model-visible 折叠文本（与 v12 transformContextMessages 的 projectedUserText
 * 同构）。未验证或无法解码 → UNVERIFIED 占位（fail-conservative，绝不猜测）。
 */
function projectedUserText(
  frames: ReturnType<typeof decodeInputFrames> | undefined,
  blocks: IrisBlockLayoutV1[] | undefined,
  verified: boolean,
): string {
  if (frames === undefined || !verified) {
    return "[USER REQUEST | UNVERIFIED]";
  }
  const origins = frameOrigins(blocks, frames.length);
  return frames
    .map((frame, index) => {
      const origin = origins[index];
      if (origin === undefined) {
        return `[DATA ONLY | UNTRUSTED]\n${frame.payload}`;
      }
      return `${sourceLabel(origin)}\n${frame.payload}`;
    })
    .join("\n\n");
}

/** user 消息折叠为 provider-visible 文本后的 payload。 */
function foldUserPayload(
  userMessage: AgentMessage & { role: "user" },
  companion: CustomMessage<unknown>,
): { payload: AgentMessage; paired: boolean; pairKey: string } {
  const details = companion.details as IrisInputMetaDetails | undefined;
  const iris = details?.iris;
  const pairKey = typeof iris?.pairKey === "string" ? iris.pairKey : "";
  const verified = verifyCompanionLayoutHash(details ?? {});
  const raw = Array.isArray(userMessage.content)
    ? userMessage.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : userMessage.content;
  let frames: ReturnType<typeof decodeInputFrames> | undefined;
  try {
    const decoded = decodeInputFrames(raw);
    frames = decoded.length > 0 ? decoded : undefined;
  } catch {
    frames = undefined;
  }
  const text = projectedUserText(frames, iris?.blocks, verified && pairKey !== "");
  return {
    payload: {
      role: "user",
      content: text,
      timestamp: userMessage.timestamp,
    },
    paired: verified && pairKey !== "",
    pairKey,
  };
}

/**
 * R2-P0：确定性可重放 Context ingest。从 runtime-event ledger 读取已提交
 * message_finalized 事件，为缺失的 source_event_id 创建 ContextMessageUnit
 * （context_seq 每 session 单调分配），companion 配对按事件顺序（ledger
 * event_seq 邻接，等价于 pi append 顺序）折叠。
 */
export class ContextIngest implements ContextIngestPort {
  constructor(
    private readonly ledger: RuntimeEventIngestPort,
    private readonly units: ContextUnitStorePort,
  ) {}

  ensureUnitsUpTo(
    runtimeSessionId: string,
    options: { limit?: number } = {},
  ): ContextMessageUnit[] {
    const events = this.ledger.listBySession(runtimeSessionId, options);
    let pendingInputSeq = this.units.lastUnpairedInputSeq(runtimeSessionId);
    for (const event of events) {
      if (event.type !== "message_finalized") {
        continue;
      }
      if (this.units.hasUnitForEvent(event.eventId)) {
        continue; // exactly-once：已建单元的事件跳过
      }
      if (event.payload === undefined) {
        continue; // 无内容的事件无法建语义单元（fail-closed：不猜测）
      }
      let message: AgentMessage;
      try {
        message = JSON.parse(event.payload) as AgentMessage;
      } catch {
        continue; // 损坏 payload：跳过（fail-closed）
      }

      if (message.role === "user") {
        const seq = this.units.maxContextSeq(runtimeSessionId) + 1;
        this.units.insertUnit({
          runtimeSessionId,
          contextSeq: seq,
          unitId: `input-${event.entryId ?? event.eventId}`,
          sourceEventId: event.eventId,
          unitType: "input",
          disposition: "include",
          ...(event.entryId !== undefined ? { entryId: event.entryId } : {}),
          ...(event.entrySeq !== undefined ? { entrySeq: event.entrySeq } : {}),
          contentHash: event.contentHash ?? "",
          payload: message,
          paired: false,
          derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
          createdAt: event.occurredAt,
        });
        pendingInputSeq = seq;
        continue;
      }

      if (isInputMetaCompanion(message)) {
        const pending = pendingInputSeq;
        if (pending === undefined) {
          continue; // 孤立 companion：不建单元（fail-closed）
        }
        const userUnit = this.units.listUnits(runtimeSessionId, {
          afterContextSeq: pending - 1,
        })[0];
        if (userUnit === undefined || userUnit?.unitType !== "input") {
          continue;
        }
        const userMessage = userUnit.payload as AgentMessage & { role: "user" };
        const folded = foldUserPayload(userMessage, message);
        this.units.updateUnitPairing(runtimeSessionId, userUnit.contextSeq, {
          companionEntryId: event.entryId ?? "",
          pairKey: folded.pairKey,
          paired: folded.paired,
          payload: folded.payload,
        });
        pendingInputSeq = undefined;
        continue;
      }

      const unitType =
        message.role === "assistant"
          ? "assistant"
          : message.role === "toolResult"
            ? "tool_result"
            : null;
      if (unitType === null) {
        continue; // 其他 role（如 reasoning/compaction 标签）不建单元
      }
      const seq = this.units.maxContextSeq(runtimeSessionId) + 1;
      this.units.insertUnit({
        runtimeSessionId,
        contextSeq: seq,
        unitId: `${unitType}-${event.entryId ?? event.eventId}`,
        sourceEventId: event.eventId,
        unitType,
        disposition: "include",
        ...(event.entryId !== undefined ? { entryId: event.entryId } : {}),
        ...(event.entrySeq !== undefined ? { entrySeq: event.entrySeq } : {}),
        contentHash: event.contentHash ?? "",
        payload: message,
        paired: false,
        derivationRefs: { memoryRefs: [], compartmentIds: [], sourceContextUnitIds: [] },
        createdAt: event.occurredAt,
      });
    }
    return this.units.listUnits(runtimeSessionId);
  }

  listUnits(
    runtimeSessionId: string,
    options: { afterContextSeq?: number; limit?: number } = {},
  ): ContextMessageUnit[] {
    return this.units.listUnits(runtimeSessionId, options);
  }

  close(): void {
    this.units.close();
  }
}
