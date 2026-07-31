import { createHash } from "node:crypto";
import test from "node:test";

import assert from "node:assert/strict";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";
import type { AgentInput } from "../src/contracts/origin.js";
import { directUserRequest } from "../src/contracts/origin.js";
import {
  computeContentLayoutHash,
  createInputMetaCompanion,
  decodeInputFrames,
  encodeInputFrames,
} from "../src/runtime/companion.js";
import { transformContextMessages } from "../src/runtime/context-adapter.js";

function textOf(message: AgentMessage | undefined): string {
  if (message?.role !== "user") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function sampleInput(blocks: AgentInput["blocks"]): AgentInput {
  return {
    inputId: "input-multiblock",
    triggerOrigin: directUserRequest(),
    blocks,
    interaction: { interactionId: "interaction-multiblock" },
  };
}

test("multi-block frames round-trip with per-frame byte lengths", () => {
  const input = sampleInput([
    {
      blockId: "block-a",
      sourceOrigin: directUserRequest(),
      content: { mode: "inline_text", text: "first line\nsecond line" },
      contentHash: createHash("sha256").update("first").digest("hex"),
    },
    {
      blockId: "block-b",
      sourceOrigin: directUserRequest(),
      content: {
        mode: "external_ref",
        ref: {
          schemaVersion: 1,
          kind: "text",
          hash: createHash("sha256").update("uri").digest("hex"),
          byteLength: 18,
          uri: "file:///tmp/example.txt",
        },
      },
      contentHash: createHash("sha256").update("ref").digest("hex"),
    },
  ]);

  const wire = encodeInputFrames(input.blocks);
  const frames = decodeInputFrames(wire);

  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.payload, "first line\nsecond line");
  assert.equal(frames[1]?.payload, "file:///tmp/example.txt");
  assert.equal(frames[0]?.utf8ByteLength, Buffer.byteLength("first line\nsecond line", "utf8"));
});

test("orphan iris_input_meta is filtered and raw body is not projected", () => {
  const input = sampleInput([
    {
      blockId: "block-a",
      sourceOrigin: directUserRequest(),
      content: { mode: "inline_text", text: "orphan request" },
      contentHash: createHash("sha256").update("orphan").digest("hex"),
    },
  ]);
  const wire = encodeInputFrames(input.blocks);
  const user: AgentMessage = { role: "user", content: wire, timestamp: 1 };
  const orphan: AgentMessage = {
    role: "custom",
    customType: IRIS_INPUT_META_CUSTOM_TYPE,
    content: IRIS_INPUT_META_CONTENT,
    display: false,
    details: {},
    timestamp: 2,
  };

  const result = transformContextMessages({
    invocationId: "invocation-orphan",
    runtimeSessionId: "session-orphan",
    messages: [user, orphan],
    model: { provider: "mock", modelId: "mock" },
    providerProfileId: "mock-iris-provider-v1",
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
  assert.equal(textOf(result.messages[0]), "[USER REQUEST | UNVERIFIED]");
});

test("corrupted companion pair key falls back to untrusted anchor", () => {
  const input = sampleInput([
    {
      blockId: "block-a",
      sourceOrigin: directUserRequest(),
      content: { mode: "inline_text", text: "corrupted pair" },
      contentHash: createHash("sha256").update("corrupted").digest("hex"),
    },
  ]);
  const wire = encodeInputFrames(input.blocks);
  const companion = createInputMetaCompanion(
    input,
    computeContentLayoutHash(input, wire),
    "2026-08-01T00:00:00.000Z",
  );
  const corrupted = {
    ...companion,
    details: {
      iris: {
        ...(companion.details as { iris: Record<string, unknown> }).iris,
        pairKey: "wrong-pair-key",
      },
    },
  } as AgentMessage;
  const user: AgentMessage = { role: "user", content: wire, timestamp: 1 };

  const result = transformContextMessages({
    invocationId: "invocation-corrupt",
    runtimeSessionId: "session-corrupt",
    messages: [user, corrupted],
    model: { provider: "mock", modelId: "mock" },
    providerProfileId: "mock-iris-provider-v1",
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
  assert.equal(textOf(result.messages[0]), "[USER REQUEST | UNVERIFIED]");
});

test("verified input pair projects the decoded request body", () => {
  const input = sampleInput([
    {
      blockId: "block-a",
      sourceOrigin: directUserRequest(),
      content: { mode: "inline_text", text: "verified request" },
      contentHash: createHash("sha256").update("verified").digest("hex"),
    },
  ]);
  const wire = encodeInputFrames(input.blocks);
  const companion = createInputMetaCompanion(
    input,
    computeContentLayoutHash(input, wire),
    "2026-08-01T00:00:00.000Z",
  );
  const user: AgentMessage = { role: "user", content: wire, timestamp: 1 };

  const result = transformContextMessages({
    invocationId: "invocation-verified",
    runtimeSessionId: "session-verified",
    messages: [user, companion],
    model: { provider: "mock", modelId: "mock" },
    providerProfileId: "mock-iris-provider-v1",
  });

  assert.equal(result.messages.length, 1);
  assert.equal(textOf(result.messages[0]), "[USER REQUEST | LIMITED]\nverified request");
});
