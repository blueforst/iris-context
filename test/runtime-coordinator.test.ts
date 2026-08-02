import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { AgentHarness } from "@earendil-works/pi-agent-core";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { createIrisHarness, type InvocationBinding } from "../src/runtime/harness-factory.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createMockProvider } from "../src/runtime/mock-provider.js";
import { RuntimeCoordinator } from "../src/runtime/runtime-coordinator.js";
import { directUserRequest } from "../src/contracts/origin.js";
import type { AgentInput } from "../src/contracts/origin.js";
import {
  makeReadOnlyTestTool,
  prepareContextSources,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { openOrCreateSessionHelper } from "./helpers/slice-helpers.js";

function buildCoordinator(options?: { maxQueuedInputs?: number }): Promise<{
  coordinator: RuntimeCoordinator;
  currentInvocation: InvocationBinding;
  dataRoot: string;
}> {
  return (async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "iris-coordinator-"));
    const config = defaultAgentConfig();
    const input = sampleAgentInput();
    const now = "2026-08-01T00:00:00.000Z";
    const paths = resolveDataRootPaths(dataRoot, config);
    initializeDataRoot(dataRoot, config);
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    const epoch = epochStore.ensureActive(now);
    const prepared = prepareContextSources(
      input,
      epoch.runtimeSessionId,
      epoch.epochId,
      config,
      now,
    );
    const currentInvocation: InvocationBinding = {
      input,
      prepared,
      invocationId: `invocation-${input.inputId}`,
    };
    const { models, model } = createMockProvider();
    const sessionHandle = await openOrCreateSessionHelper(dataRoot, config, epoch.runtimeSessionId);
    const session = sessionHandle.session;
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      currentInvocation,
      now,
      providerProfileId: "mock-iris-provider-v1",
    });
    const coordinator = new RuntimeCoordinator({
      harness,
      currentInvocation,
      prepareInvocation: async (nextInput: AgentInput) =>
        prepareContextSources(nextInput, epoch.runtimeSessionId, epoch.epochId, config, now),
      ...(options?.maxQueuedInputs !== undefined
        ? { maxQueuedInputs: options.maxQueuedInputs }
        : {}),
    });
    return { coordinator, currentInvocation, dataRoot };
  })();
}

test("coordinator runs one invocation to settled and releases the latch", async () => {
  const { coordinator } = await buildCoordinator();
  const input = sampleAgentInput();

  const events: string[] = [];
  for await (const event of coordinator.prompt(input)) {
    events.push(event.type);
  }

  assert.ok(events.includes("turn_start"));
  assert.ok(events.includes("settled"));
  assert.equal(coordinator.getPhase(), "idle");

  // Latch released: a second invocation may start.
  const events2: string[] = [];
  for await (const event of coordinator.prompt(input)) {
    events2.push(event.type);
  }
  assert.ok(events2.includes("settled"));
});

test("coordinator rejects a second prompt while an invocation is active", async () => {
  const { coordinator } = await buildCoordinator();
  const input = sampleAgentInput();

  const iterator = coordinator.prompt(input)[Symbol.asyncIterator]();
  await iterator.next(); // turn_start consumed; latch now held

  await assert.rejects(
    (async () => {
      for await (const event of coordinator.prompt(input)) {
        void event;
      }
    })(),
    /already active/,
  );

  // Drain the original invocation to release the latch.
  await iterator.return?.();
});

test("coordinator queues inputs and reports queued count", async () => {
  const { coordinator } = await buildCoordinator();
  coordinator.enqueue(sampleAgentInput());
  coordinator.enqueue(sampleAgentInput());
  assert.equal(coordinator.queuedCount(), 2);
});

test("coordinator dequeues queued inputs in FIFO order", async () => {
  const { coordinator } = await buildCoordinator();
  const first = sampleAgentInput();
  const second = { ...sampleAgentInput(), inputId: "input-0002" };
  coordinator.enqueue(first);
  coordinator.enqueue(second);
  assert.equal(coordinator.dequeue()?.inputId, first.inputId);
  assert.equal(coordinator.dequeue()?.inputId, second.inputId);
  assert.equal(coordinator.dequeue(), undefined);
  assert.equal(coordinator.queuedCount(), 0);
});

test("coordinator forwards native tool_call and tool_result events", async () => {
  // Review blocker #2 (event forwarding): the port stream must carry the
  // native tool_call/tool_result events, not only turn_start/settled.
  const { coordinator } = await buildCoordinator();
  const input = sampleAgentInput();

  const eventTypes: string[] = [];
  const toolEvents: string[] = [];
  for await (const event of coordinator.prompt(input)) {
    eventTypes.push(event.type);
    if (event.type === "tool_call" || event.type === "tool_result") {
      toolEvents.push(`${event.type}:${event.toolName}`);
    }
  }

  assert.ok(eventTypes.includes("settled"));
  assert.ok(
    toolEvents.some((entry) => entry === "tool_call:test_read_tool"),
    `expected a native tool_call event, got ${JSON.stringify(toolEvents)}`,
  );
  assert.ok(
    toolEvents.some((entry) => entry === "tool_result:test_read_tool"),
    `expected a native tool_result event, got ${JSON.stringify(toolEvents)}`,
  );
});

test("second prompt rebinds companion and context to the current input", async () => {
  // Review blocker #1: after A settled, prompting B must pair B's companion
  // and B's ContextSourceSnapshot — never A's. The canonical system prompt
  // embeds the inputId, and the session companion metadata carries it.
  const { coordinator, currentInvocation } = await buildCoordinator();
  const inputA = sampleAgentInput();
  const inputB: AgentInput = {
    ...sampleAgentInput(),
    inputId: "input-0002",
    blocks: [
      {
        blockId: "block-0002",
        sourceOrigin: directUserRequest(),
        content: { mode: "inline_text", text: "second invocation" },
        contentHash: createHash("sha256").update("second invocation").digest("hex"),
      },
    ],
  };

  for await (const event of coordinator.prompt(inputA)) {
    assert.notEqual(event.type, "failed");
  }
  assert.equal(currentInvocation.input.inputId, inputA.inputId);

  for await (const event of coordinator.prompt(inputB)) {
    assert.notEqual(event.type, "failed");
  }

  // The binding slot now reflects B, and B's canonical system prompt was used.
  assert.equal(currentInvocation.input.inputId, inputB.inputId);
  assert.equal(currentInvocation.invocationId, `invocation-${inputB.inputId}`);
  assert.ok(
    currentInvocation.prepared.canonicalSystemPrompt.includes(inputB.inputId),
    "canonical system prompt must embed the current invocation's inputId",
  );
});

test("coordinator queue rejects beyond capacity", async () => {
  const { coordinator } = await buildCoordinator({ maxQueuedInputs: 1 });
  coordinator.enqueue(sampleAgentInput());
  assert.throws(() => {
    coordinator.enqueue(sampleAgentInput());
  }, /queue full/);
});

test("coordinator forwards abort to the Pi harness and releases the latch", async () => {
  // A controllable fake harness that parks its prompt() until abort() is
  // called, then emits native settled — matching the Pi abort contract
  // (abort -> native agent_end/settled -> release invocation).
  let abortCalled = false;
  let releasePrompt: (() => void) | undefined;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const harness = {
    async prompt(): Promise<{ role: "assistant"; content: [] }> {
      await promptGate;
      return { role: "assistant", content: [] };
    },
    async abort(): Promise<void> {
      abortCalled = true;
      releasePrompt?.();
    },
    subscribe(listener: (event: { type: string; nextTurnCount?: number }) => void): () => void {
      // After the abort releases the gate, emit native settled so the
      // coordinator observes a proper end boundary before releasing.
      void promptGate.then(() => {
        listener({ type: "settled", nextTurnCount: 0 });
      });
      return () => undefined;
    },
  } as unknown as AgentHarness;

  const currentInvocation = {
    input: sampleAgentInput(),
    prepared: {} as InvocationBinding["prepared"],
    invocationId: "invocation-input-0001",
  };
  const coordinator = new RuntimeCoordinator({
    harness,
    currentInvocation,
    prepareInvocation: async (nextInput: AgentInput) => {
      void nextInput;
      return currentInvocation.prepared;
    },
  });
  const input = sampleAgentInput();
  const invocationId = `invocation-${input.inputId}`;
  const events: string[] = [];
  const promptPromise = (async () => {
    for await (const event of coordinator.prompt(input)) {
      events.push(event.type);
    }
  })();

  // Wait until the invocation is active, then abort with the correct id.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(coordinator.getPhase(), "turn");
  await coordinator.abort(invocationId);
  assert.equal(abortCalled, true);

  await promptPromise;
  assert.equal(coordinator.getPhase(), "idle");
  assert.ok(events.includes("turn_start"));
  // The coordinator only released the latch after observing native settled
  // (review blocker #2): abort alone must not release the invocation.
  assert.ok(events.includes("settled"));
  assert.equal(events.includes("failed"), false);

  // Abort with a wrong invocation id is rejected after the latch released.
  await assert.rejects(coordinator.abort("invocation-nonexistent"), /no active invocation/);
});
