/**
 * Crash-boundary worker for the R1 crash-window suite.
 *
 * Runs inside a child process, advances a real data root to the named
 * boundary, then parks (sleeps) so the parent can SIGKILL it mid-state.
 * Every boundary writes a marker file before parking; the parent asserts the
 * marker and the resulting persisted state after a real process kill.
 *
 * Boundaries (matching the R1 Exit Gate crash windows):
 *  - before_any_write          : data root initialized, nothing persisted
 *  - after_user_append         : UserMessage committed, no companion yet
 *  - after_companion_append    : input pair (user + iris_input_meta) committed
 *  - after_settled             : full mock slice reached settled
 *  - after_epoch_created       : active Epoch row exists
 *  - after_tool_result_commit  : slice finished (tool result committed)
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-storage-sqlite-node";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { acquireDataRootLock } from "../src/host/lock.js";
import { RuntimeEpochStore } from "../src/runtime/epoch-manager.js";
import { nodeSqliteRepoEnv } from "../src/runtime/pi-env.js";
import { runMinimalSlice, sampleAgentInput } from "../src/runtime/vertical-slice.js";
import { IRIS_INPUT_META_CONTENT, IRIS_INPUT_META_CUSTOM_TYPE } from "../src/contracts/context.js";

const boundaryIndex = process.argv.indexOf("--boundary");
const boundary = boundaryIndex >= 0 ? process.argv[boundaryIndex + 1] : "before_any_write";
const dataRootIndex = process.argv.indexOf("--data-root");
const rawDataRoot = dataRootIndex >= 0 ? process.argv[dataRootIndex + 1] : undefined;
const dataRoot = rawDataRoot ?? mkdtempSync(join(tmpdir(), "iris-crash-worker-"));

const marker = join(dataRoot, "crash-marker.json");
const config = defaultAgentConfig();
const paths = resolveDataRootPaths(dataRoot, config);

function park(): Promise<never> {
  writeFileSync(marker, JSON.stringify({ boundary, reachedAt: new Date().toISOString() }), "utf8");
  // Park forever; the parent kills this process at this exact state. The
  // periodic timer keeps the event loop (and the process) alive so the
  // parent's SIGKILL genuinely lands on a live process — a throw here would
  // crash the worker on its own and make the parent's kill a no-op.
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}

// settled/tool_result boundaries run the full slice, which manages its own
// data-root lock; do not hold the outer lock concurrently.
if (boundary === "after_settled" || boundary === "after_tool_result_commit") {
  await runMinimalSlice({
    dataRoot,
    config,
    input: sampleAgentInput(),
    provider: "mock",
  });
  await park();
}

const lock = await acquireDataRootLock(dataRoot, paths.lockFile);
try {
  initializeDataRoot(dataRoot, config);

  if (boundary === "before_any_write") {
    await park();
  }

  if (boundary === "after_epoch_created") {
    const epochStore = new RuntimeEpochStore(
      paths.epochRegistryDb,
      config.runtime_sessions.session_id_prefix,
      config.runtime_sessions.timezone,
    );
    epochStore.ensureActive("2026-08-01T00:00:00.000Z");
    epochStore.close();
    await park();
  }

  const repo = new SqliteSessionRepo({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const session = await repo.create({ id: "crash-session", cwd: dataRoot });

  if (boundary === "after_user_append") {
    await session.appendMessage({
      role: "user",
      content: "IRIS_INPUT_V1\ninline_text:14\ncrash boundary\n",
      timestamp: Date.now(),
    });
    await park();
  }

  if (boundary === "after_companion_append") {
    await session.appendMessage({
      role: "user",
      content: "IRIS_INPUT_V1\ninline_text:14\ncrash boundary\n",
      timestamp: Date.now(),
    });
    await session.appendCustomMessageEntry(
      IRIS_INPUT_META_CUSTOM_TYPE,
      IRIS_INPUT_META_CONTENT,
      false,
      {
        iris: {
          schemaVersion: 1,
          inputId: "crash-input-0001",
          pairKey: "crash-pair-key",
          contentLayoutHash: "crash-layout-hash",
          blocks: [],
        },
      },
    );
    await park();
  }

  throw new Error(`unknown boundary: ${boundary}`);
} finally {
  await lock.release();
}
