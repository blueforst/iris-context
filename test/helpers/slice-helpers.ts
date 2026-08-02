import type { Session } from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-storage-sqlite-node";

import type { AgentConfigV3 } from "../../src/config/schema.js";
import { resolveDataRootPaths } from "../../src/host/data-root.js";
import { nodeSqliteRepoEnv } from "../../src/runtime/pi-env.js";

export async function openOrCreateSessionHelper(
  dataRoot: string,
  config: AgentConfigV3,
  runtimeSessionId: string,
): Promise<{ repo: SqliteSessionRepo; session: Session }> {
  const paths = resolveDataRootPaths(dataRoot, config);
  const repo = new SqliteSessionRepo({
    env: nodeSqliteRepoEnv(dataRoot),
    sqlite: createNodeSqliteFactory(),
    databasePath: paths.sessionDb,
  });
  const list = await repo.list({ cwd: dataRoot });
  const metadata = list.find((candidate) => candidate.id === runtimeSessionId);
  if (metadata !== undefined) {
    return { repo, session: await repo.open(metadata) };
  }
  return { repo, session: await repo.create({ id: runtimeSessionId, cwd: dataRoot }) };
}

export async function closeSessionStorageHelper(session: Session): Promise<void> {
  const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
  await storage.cleanup();
}
