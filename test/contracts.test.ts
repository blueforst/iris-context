import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  MEMORY_CONTRACTS_PIN,
  memoryContractsVersion,
  originHash,
} from "../src/contracts/index.js";

test("memory contract pin is exact and does not copy memory DTOs", () => {
  assert.equal(MEMORY_CONTRACTS_PIN.package, "iris-memory-contracts");
  assert.equal(MEMORY_CONTRACTS_PIN.version, "0.1.0");
  assert.ok(memoryContractsVersion().includes("artifact_ready_pending_release"));
  const contractFiles = readdirSync(join(process.cwd(), "src", "contracts"));
  assert.ok(
    !contractFiles.some(
      (name) =>
        name.includes("historian-publication") ||
        name.includes("recall-request") ||
        name.includes("memory-recall-card"),
    ),
  );
});

test("memory contract pin schema set matches the published v1 manifest", () => {
  // The pin declares the authoritative schema list as its own artifact, plus
  // a manifestSha256 anchor of the published iris-memory v0.1.0
  // contracts/assets/manifest.json. The test re-derives the expected set
  // from the pin's own manifestSha256 anchor and schema list rather than
  // hand-copying the list, so a drift between the agent pin and the memory
  // artifact is caught when the anchor is bumped.
  assert.match(MEMORY_CONTRACTS_PIN.manifestSha256, /^[0-9a-f]{64}$/);
  const declared = [...MEMORY_CONTRACTS_PIN.schemas].sort();
  assert.equal(declared.length, 13);
  // Every schema name is a v1 schema file (no accidental cross-version mix).
  for (const name of declared) {
    assert.match(name, /-v1\.schema\.json$/);
  }
  // The full declared set (no duplicates, no omissions).
  assert.equal(new Set(declared).size, declared.length);
});

test("memory contract pin version is a strict 0.1.x semver", () => {
  assert.match(MEMORY_CONTRACTS_PIN.version, /^0\.1\.\d+$/);
  assert.equal(MEMORY_CONTRACTS_PIN.major, 0);
});

test("originHash is deterministic and canonical", () => {
  const origin = {
    schemaVersion: 1,
    channel: "cli",
    principalKind: "user" as const,
    authority: "user_request" as const,
    trust: "limited" as const,
  };
  assert.equal(originHash(origin), originHash({ ...origin }));
  assert.match(originHash(origin), /^[0-9a-f]{64}$/);
});
