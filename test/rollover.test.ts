import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import {
  reopenActiveSession,
  rolloverActiveSession,
  runMinimalSlice,
  sampleAgentInput,
} from "../src/runtime/vertical-slice.js";

test("settled rollover closes the old epoch and activates a fresh linked epoch", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-test-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";

  const first = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput(), now });
  assert.equal(first.epochId, "iris-runtime-2026-08-01-1");

  const rolled = await rolloverActiveSession({ dataRoot, config, now });
  assert.notEqual(rolled.newEpochId, rolled.previousEpochId);
  assert.notEqual(rolled.newSessionId, rolled.previousSessionId);
  assert.equal(rolled.previousStatus, "closed");

  // The new session is a fresh empty Pi Session (no copied history).
  assert.equal(rolled.entries.length, 0);

  // The new epoch links back through previous_epoch_id.
  const paths = resolveDataRootPaths(dataRoot, config);
  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  const active = store.getActive();
  assert.equal(active?.epochId, rolled.newEpochId);
  assert.equal(active?.previousEpochId, rolled.previousEpochId);
  store.close();
});

test("rollover requires an explicit request first", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-guard-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  assert.throws(() => store.rolloverAfterSettled(now), /without requestRollover/);
  store.close();
});

test("rollover keeps a single active epoch invariant", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-invariant-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  initializeDataRoot(dataRoot, config);

  const store = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  store.ensureActive(now);
  store.requestRollover("invariant-check");
  store.rolloverAfterSettled(now);

  const all = store.getActive();
  assert.ok(all !== null);
  store.close();

  // After rollover the old session is closed and a fresh session exists.
  const reopened = await reopenActiveSession({ dataRoot, config, input: sampleAgentInput(), now });
  assert.equal(reopened.runtimeSessionId, all.runtimeSessionId);
  assert.equal(reopened.entries.length, 0);
});

test("rollover does not create synthetic repair artifacts", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-rollover-artifacts-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";

  await runMinimalSlice({ dataRoot, config, input: sampleAgentInput(), now });
  await rolloverActiveSession({ dataRoot, config, now });

  assert.ok(!existsSync(join(dataRoot, "invocation.db")));
  assert.ok(!existsSync(join(dataRoot, "result.db")));
});
