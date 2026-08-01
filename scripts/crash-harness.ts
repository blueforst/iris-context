import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-storage-sqlite-node";

import { defaultAgentConfig } from "../src/config/load.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";
import { acquireDataRootLock } from "../src/host/lock.js";
import { nodeSqliteRepoEnv } from "../src/runtime/pi-env.js";
import { runMinimalSlice, sampleAgentInput } from "../src/runtime/vertical-slice.js";

const boundaryIndex = process.argv.indexOf("--boundary");
const boundary = boundaryIndex >= 0 ? process.argv[boundaryIndex + 1] : "before_any_write";
const dataRoot = mkdtempSync(join(tmpdir(), "iris-crash-harness-"));
const config = defaultAgentConfig();
const paths = resolveDataRootPaths(dataRoot, config);

if (boundary === "after_settled") {
  const result = await runMinimalSlice({ dataRoot, config, input: sampleAgentInput() });
  console.log(
    JSON.stringify({
      boundary,
      status: "reached",
      entries: result.entries.length,
      settled: result.observers.settled,
    }),
  );
} else {
  const lock = await acquireDataRootLock(dataRoot, paths.lockFile);
  try {
    initializeDataRoot(dataRoot, config);
    if (boundary === "before_any_write") {
      console.log(JSON.stringify({ boundary, status: "reached", entries: 0 }));
    } else if (boundary === "after_user_append") {
      const repo = new SqliteSessionRepo({
        env: nodeSqliteRepoEnv(dataRoot),
        sqlite: createNodeSqliteFactory(),
        databasePath: paths.sessionDb,
      });
      const session = await repo.create({ id: "crash-session", cwd: dataRoot });
      await session.appendMessage({
        role: "user",
        content: "crash boundary",
        timestamp: Date.now(),
      });
      const entries = await session.getEntries();
      console.log(JSON.stringify({ boundary, status: "reached", entries: entries.length }));
    } else if (boundary === "after_companion_append") {
      const repo = new SqliteSessionRepo({
        env: nodeSqliteRepoEnv(dataRoot),
        sqlite: createNodeSqliteFactory(),
        databasePath: paths.sessionDb,
      });
      const session = await repo.create({ id: "crash-session", cwd: dataRoot });
      await session.appendMessage({
        role: "user",
        content: "crash boundary",
        timestamp: Date.now(),
      });
      await session.appendCustomMessageEntry("iris_input_meta", "<iris-input-meta/>", false, {
        iris: { schemaVersion: 1, pairKey: "crash-pair" },
      });
      const entries = await session.getEntries();
      console.log(JSON.stringify({ boundary, status: "reached", entries: entries.length }));
    } else {
      throw new Error(`unknown boundary: ${boundary}`);
    }
  } finally {
    await lock.release();
  }
}
