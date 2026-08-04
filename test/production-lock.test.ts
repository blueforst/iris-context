import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { readProductionLock } from "../src/contracts/production-lock.js";
import { readContractPin } from "../src/contracts/memory-pin.js";

/**
 * Production lock gate (Roadmap v13, R0 Exit Gate: production lock 无 TBD).
 *
 * The lock is the single source of truth for pinned versions across the
 * three-project boundary: Pi (release packages + controlled fork baseline),
 * Magic Context (OpenCode released authority), memory contracts artifact and
 * the Graphiti/Neo4j candidate lock owned by iris_memory.
 */

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /\b(TBD|TODO|unknown)\b/i;

function walkStrings(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(`${path}=${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkStrings(v, `${path}[${i}]`, out);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(v, `${path}.${k}`, out);
    }
  }
}

test("r0: production lock schemaVersion is 1 and documented", () => {
  const lock = readProductionLock();
  assert.equal(lock.schemaVersion, 1);
  assert.match(lock.documentedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("r0: production lock contains no TBD/TODO/unknown placeholder", () => {
  const lock = readProductionLock();
  const strings: string[] = [];
  walkStrings(lock, "lock", strings);
  const offenders = strings.filter((s) => PLACEHOLDER.test(s));
  assert.deepEqual(offenders, [], "production lock must not contain unset placeholders");
});

test("r0: all pinned SHAs are full-length hex", () => {
  const lock = readProductionLock();
  assert.match(lock.pi.fork.baselineCommit, SHA40);
  assert.match(lock.pi.fork.upstreamBaseCommit, SHA40);
  assert.match(lock.pi.fork.upstreamAuditBaselineCommit, SHA40);
  assert.match(lock.magicContext.commit, SHA40);
  assert.match(lock.memoryContracts.manifestSha256, SHA256);
});

test("r0: Pi package pins match package.json dependencies exactly", () => {
  const lock = readProductionLock();
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const [name, version] of Object.entries(lock.pi.packages)) {
    assert.equal(pkg.dependencies[name], version, `package.json must pin ${name}@${version}`);
  }
  // The agent must not silently add other Pi packages without lock coverage.
  const piPkgs = Object.keys(pkg.dependencies).filter((n) => n.startsWith("@earendil-works/pi-"));
  assert.deepEqual(piPkgs.sort(), Object.keys(lock.pi.packages).sort());
});

test("r0: memory contract pin and production lock agree on the artifact", () => {
  const lock = readProductionLock();
  const pin = readContractPin();
  assert.equal(lock.memoryContracts.package, pin.package);
  assert.equal(lock.memoryContracts.version, pin.version);
  assert.equal(lock.memoryContracts.manifestSha256, pin.manifestSha256);
  assert.equal(lock.memoryContracts.owner, pin.owner);
});

test("r0: agent has no direct Graphiti/Neo4j dependency", () => {
  const lock = readProductionLock();
  assert.equal(lock.graphitiNeo4j.agentDirectDependency, false);
  assert.equal(lock.graphitiNeo4j.owner, "blueforst/iris_memory");
});

test("r0: toolchain lock is npm with package-lock.json and Node 22.19+", () => {
  const lock = readProductionLock();
  assert.equal(lock.toolchain.packageManager, "npm");
  assert.equal(lock.toolchain.lockfile, "package-lock.json");
  assert.equal(lock.toolchain.nodeCiExact, "22.19.0");
});

test("r0: Magic Context authority is the released OpenCode implementation", () => {
  const lock = readProductionLock();
  assert.equal(lock.magicContext.repository, "cortexkit/magic-context");
  assert.equal(lock.magicContext.release, "v0.33.0");
  assert.ok(lock.magicContext.authoritativePath.includes("magic-context"));
  assert.ok(lock.magicContext.explicitlyNotAdopted.includes("experimental.memory_mural"));
});
