import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { openHost } from "../src/host/composition.js";
import { resolveDataRootPaths } from "../src/host/data-root.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";

test("openHost is exception-safe: a failed setup releases the lock", async () => {
  // Review blocker #2 (fourth pass): when a setup step fails, the Session
  // storage / Epoch store / lock must all be released so a second openHost
  // can re-acquire the lock. We force a failure by pre-creating a DIRECTORY
  // where the epoch registry DB file belongs, so RuntimeEpochStore's open
  // fails after the lock was acquired.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-failsetup-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);
  const { initializeDataRoot } = await import("../src/host/data-root.js");
  initializeDataRoot(dataRoot, config);
  // Replace the epoch DB with a directory: opening it as a DB file throws.
  if (existsSync(paths.epochRegistryDb)) {
    const { rmSync } = await import("node:fs");
    rmSync(paths.epochRegistryDb);
  }
  mkdirSync(paths.epochRegistryDb, { recursive: true });

  let threw = false;
  try {
    await openHost({ dataRoot, config, provider: "mock" });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "openHost must fail when the epoch DB path is a directory");

  // Remove the directory so the second openHost can create the DB, and
  // verify the lock was released by the failed attempt.
  const { rmSync } = await import("node:fs");
  rmSync(paths.epochRegistryDb, { recursive: true, force: true });
  const host = await openHost({ dataRoot, config, provider: "mock" });
  await host.close();
});

test("startup recovery is re-entrant across a crash between session and epoch cleanup", async () => {
  // Review blocker #1 (fourth pass): if a crash happens between deleting the
  // orphan Pi Session and deleting the creating Epoch row, the next startup
  // must still see the creating row and finish the cleanup.
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-host-rerecover-"));
  const config = defaultAgentConfig();
  const now = "2026-08-01T12:00:00.000Z";
  const paths = resolveDataRootPaths(dataRoot, config);
  const { initializeDataRoot } = await import("../src/host/data-root.js");
  initializeDataRoot(dataRoot, config);

  const epochStore = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  epochStore.ensureActive(now);
  const pending = epochStore.beginRollover(now);
  // Simulate the orphan Pi Session row having been created before the crash.
  const { openOrCreateSession } = await import("../src/runtime/vertical-slice.js");
  await openOrCreateSession(dataRoot, config, pending.runtimeSessionId);
  epochStore.close();

  // Simulate a crash AFTER the session row exists but BEFORE the epoch row
  // was deleted: the epoch store still has the creating row. A fresh openHost
  // must re-run recovery and leave a consistent state.
  const host = await openHost({ dataRoot, config, provider: "mock" });
  await host.close();

  // After re-entrant recovery: no creating rows, exactly one active epoch.
  const restarted = new RuntimeEpochStore(
    paths.epochRegistryDb,
    config.runtime_sessions.session_id_prefix,
    config.runtime_sessions.timezone,
  );
  assert.equal(restarted.listCreating().length, 0);
  assert.equal(restarted.countAll(), 1);
  assert.equal(restarted.getActive()?.epochId, "iris-runtime-2026-08-01-1");
  restarted.close();
});
