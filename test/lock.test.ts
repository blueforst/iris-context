import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { resolveDataRootPaths } from "../src/host/data-root.js";
import { acquireDataRootLock } from "../src/host/lock.js";

test("second iris.lock acquisition fails fast and release allows reacquisition", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-lock-test-"));
  const paths = resolveDataRootPaths(dataRoot, defaultAgentConfig());

  const first = await acquireDataRootLock(dataRoot, paths.lockFile);
  await assert.rejects(() => acquireDataRootLock(dataRoot, paths.lockFile));
  await first.release();

  const second = await acquireDataRootLock(dataRoot, paths.lockFile);
  await second.release();
});
