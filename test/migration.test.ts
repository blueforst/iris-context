import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import assert from "node:assert/strict";

import { defaultAgentConfig } from "../src/config/load.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { initializeDataRoot, resolveDataRootPaths } from "../src/host/data-root.js";

test("empty data root initializes and migrations are idempotent", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "iris-migration-test-"));
  const config = defaultAgentConfig();
  const paths = resolveDataRootPaths(dataRoot, config);

  initializeDataRoot(dataRoot, config);
  const second = migrateDatabase(
    paths.epochRegistryDb,
    join(process.cwd(), "src", "db", "migrations", "runtime-epochs"),
  );
  assert.deepEqual(second.appliedVersions, []);

  const db = new DatabaseSync(paths.epochRegistryDb);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(tables.includes("runtime_epochs"));
    assert.ok(tables.includes("schema_migrations"));
  } finally {
    db.close();
  }
});
