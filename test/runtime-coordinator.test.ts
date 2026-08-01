import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import type { AgentHarness } from "@earendil-works/pi-agent-core";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { createIrisHarness } from "../src/runtime/harness-factory.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { createMockProvider } from "../src/runtime/mock-provider.js";
import { RuntimeCoordinator } from "../src/runtime/runtime-coordinator.js";
import {
  makeReadOnlyTestTool,
  prepareContextSources,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";
import { openOrCreateSessionHelper } from "./helpers/slice-helpers.js";

function buildCoordinator(): Promise<{
  coordinator: RuntimeCoordinator;
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
    const { models, model } = createMockProvider();
    const sessionHandle = await openOrCreateSessionHelper(dataRoot, config, epoch.runtimeSessionId);
    const session = sessionHandle.session;
    const { harness } = createIrisHarness({
      session,
      instanceEpoch: epoch.ordinalWithinDate,
      models,
      model,
      tools: [makeReadOnlyTestTool()],
      prepared,
      input,
      invocationId: `invocation-${input.inputId}`,
      now,
      providerProfileId: "mock-iris-provider-v1",
    });
    const coordinator = new RuntimeCoordinator({ harness });
    return { coordinator, dataRoot };
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

test("coordinator queue rejects beyond capacity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-coordinator-cap-"));
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
  const prepared = prepareContextSources(input, epoch.runtimeSessionId, epoch.epochId, config, now);
  const { models, model } = createMockProvider();
  const sessionHandle = await openOrCreateSessionHelper(dataRoot, config, epoch.runtimeSessionId);
  const { harness } = createIrisHarness({
    session: sessionHandle.session,
    instanceEpoch: epoch.ordinalWithinDate,
    models,
    model,
    tools: [makeReadOnlyTestTool()],
    prepared,
    input,
    invocationId: `invocation-${input.inputId}`,
    now,
    providerProfileId: "mock-iris-provider-v1",
  });
  const coordinator = new RuntimeCoordinator({ harness, maxQueuedInputs: 1 });
  coordinator.enqueue(sampleAgentInput());
  assert.throws(() => {
    coordinator.enqueue(sampleAgentInput());
  }, /queue full/);
});

test("coordinator forwards abort to the Pi harness and releases the latch", async () => {
  // A controllable fake harness that parks its prompt() until abort() is
  // called, so the abort forwarding path is genuinely exercised (the mock
  // provider settles synchronously and would leave no abort window).
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
    subscribe(): () => void {
      return () => undefined;
    },
  } as unknown as AgentHarness;

  const coordinator = new RuntimeCoordinator({ harness });
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

  // Abort with a wrong invocation id is rejected after the latch released.
  await assert.rejects(coordinator.abort("invocation-nonexistent"), /no active invocation/);
});
