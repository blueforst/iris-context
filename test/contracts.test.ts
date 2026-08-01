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
