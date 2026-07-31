import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAgentConfig } from "../src/config/load.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { resolveDataRootPaths } from "../src/host/data-root.js";

const dataRoot = mkdtempSync(join(tmpdir(), "iris-migration-smoke-"));
const config = defaultAgentConfig();
const paths = resolveDataRootPaths(dataRoot, config);

const first = migrateDatabase(
  paths.epochRegistryDb,
  join(process.cwd(), "src", "db", "migrations", "runtime-epochs"),
);
const second = migrateDatabase(
  paths.epochRegistryDb,
  join(process.cwd(), "src", "db", "migrations", "runtime-epochs"),
);

if (first.appliedVersions.length === 0) {
  throw new Error("expected first migration run to apply versions");
}
if (second.appliedVersions.length !== 0) {
  throw new Error("expected second migration run to be idempotent");
}

console.log(
  JSON.stringify(
    {
      databasePath: first.databasePath,
      firstApplied: first.appliedVersions,
      secondApplied: second.appliedVersions,
      status: "idempotent",
    },
    null,
    2,
  ),
);
