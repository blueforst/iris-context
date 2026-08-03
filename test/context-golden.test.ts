import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "context", "opencode-v0.33.0");
const PROVENANCE_DIR = join(process.cwd(), "evidence", "context-golden");
const AUTHORITY_COMMIT = "48ab531d8fa98af2f463db2e4d9f8ffdd63d765e";
const AUTHORITY_RELEASE = "v0.33.0";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

test("context-golden: authority lock matches the released v0.33.0 commit", () => {
  const authority = JSON.parse(
    readFileSync(join(process.cwd(), "scripts", "context-golden", "authority.json"), "utf8"),
  ) as { repository: string; release: string; commit: string };
  assert.equal(authority.repository, "https://github.com/cortexkit/magic-context");
  assert.equal(authority.release, AUTHORITY_RELEASE);
  assert.equal(authority.commit, AUTHORITY_COMMIT);
});

test("context-golden: committed fixture set is complete and offline-runnable", () => {
  const expectedFixtures = [
    "taxonomy-softplus-defer-identical.json",
    "taxonomy-soft-exec-surfaces-m1.json",
    "taxonomy-hard-model-change.json",
    "taxonomy-hard-system-hash.json",
    "taxonomy-empty-hard-signal-no-fold.json",
    "taxonomy-hard-ttl-idle-fold-once.json",
    "taxonomy-pressure-backstop-m1-cap.json",
    "taxonomy-hard-markers-persist-restart.json",
    "protected-tail-suffix-walk.json",
    "protected-tail-n-clamp.json",
    "protected-tail-force-head-minimum.json",
    "constants.json",
  ];
  for (const name of expectedFixtures) {
    const content = readFileSync(join(FIXTURE_DIR, name), "utf8");
    // Offline guarantee: fixtures must be usable without the authority
    // checkout, and must never contain the forbidden Mural token.
    assert.ok(content.length > 0, `${name} must not be empty`);
    assert.doesNotMatch(content, /mural/i, `${name} must not contain Memory Mural`);
  }
  const provenance = JSON.parse(readFileSync(join(PROVENANCE_DIR, "provenance.json"), "utf8")) as {
    outputHashes: { fixtureJson: Record<string, string> };
  };
  for (const [id, recordedHash] of Object.entries(provenance.outputHashes.fixtureJson)) {
    const actual = sha256(readFileSync(join(FIXTURE_DIR, `${id}.json`), "utf8"));
    assert.equal(actual, recordedHash, `hash mismatch for ${id}.json`);
  }
});

test("context-golden: expected values are the authority's hard-coded assertions", () => {
  // These expected values were mechanically extracted from the locked
  // authority's own tests (m0m1-taxonomy.test.ts and
  // protected-tail-boundary.test.ts @ 48ab531d). If the authority moves these
  // assertions, this test breaks — by design, no silent drift.
  const softplus = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "taxonomy-softplus-defer-identical.json"), "utf8"),
  ) as {
    expected: {
      passClassification: string;
      m0Replay: string;
      m1Replay: string;
      rematerialized: boolean;
    };
  };
  assert.equal(softplus.expected.passClassification, "SOFT+");
  assert.equal(softplus.expected.m0Replay, "byte_identical");
  assert.equal(softplus.expected.m1Replay, "byte_identical");
  assert.equal(softplus.expected.rematerialized, false);

  const soft = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "taxonomy-soft-exec-surfaces-m1.json"), "utf8"),
  ) as {
    expected: {
      passClassification: string;
      m0Replay: string;
      m1Replay: string;
      rematerialized: boolean;
    };
  };
  assert.equal(soft.expected.passClassification, "SOFT");
  assert.equal(soft.expected.m0Replay, "byte_identical");
  assert.equal(soft.expected.m1Replay, "re_rendered");
  assert.equal(soft.expected.rematerialized, false);

  const hard = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "taxonomy-hard-model-change.json"), "utf8"),
  ) as {
    expected: {
      passClassification: string;
      reason: string;
      rematerialized: boolean;
      m1Replay: string;
    };
  };
  assert.equal(hard.expected.passClassification, "HARD");
  assert.equal(hard.expected.reason, "model_change");
  assert.equal(hard.expected.rematerialized, true);
  assert.equal(hard.expected.m1Replay, "reset_to_placeholder");

  const constants = JSON.parse(readFileSync(join(FIXTURE_DIR, "constants.json"), "utf8")) as {
    constants: Record<string, string | number>;
  };
  // Fixed placeholder bytes from inject-compartments.ts (authority).
  assert.equal(constants.constants["M0_EMPTY_BODY"], "<session-history></session-history>");
  assert.equal(
    constants.constants["M1_EMPTY_PLACEHOLDER"],
    "<session-history-since>(no new content since last materialization)</session-history-since>",
  );
  // Fixed pressure gates from compartment-trigger.ts (authority).
  assert.equal(constants.constants["FORCE_COMPARTMENT_PERCENTAGE"], 80);
  assert.equal(constants.constants["BLOCK_UNTIL_DONE_PERCENTAGE"], 95);
  assert.equal(constants.constants["FORCE_MATERIALIZE_PERCENTAGE"], 85);
  assert.equal(constants.constants["TAIL_SIZE_TRIGGER_MULTIPLIER"], 3);
  // Fixed budget bases from derive-budgets.ts (authority).
  assert.equal(constants.constants["TRIGGER_BUDGET_PERCENTAGE"], 0.05);
  assert.equal(constants.constants["HISTORIAN_CHUNK_PERCENTAGE"], 0.25);
  assert.equal(constants.constants["DEFAULT_HISTORIAN_CONTEXT_FALLBACK"], 128_000);
  // Protected-tail constants (authority).
  assert.equal(constants.constants["RECOVERY_NO_HEAD_LIMIT"], 2);
  assert.equal(constants.constants["MIN_FORCE_ELIGIBLE_TOKENS_CAP"], 1_000);
  // Sentinel (authority).
  assert.equal(constants.constants["WHOLE_MESSAGE_PLACEHOLDER_TEXT"], "[dropped]");
});

test("context-golden: provenance manifest is complete and self-consistent", () => {
  const provenance = JSON.parse(readFileSync(join(PROVENANCE_DIR, "provenance.json"), "utf8")) as {
    generatorVersion: string;
    serializerVersion: string;
    sourceRepository: string;
    release: string;
    authorityCommit: string;
    authoritativeFiles: string[];
    outputHashes: { constantsJson: string; fixtureJson: Record<string, string> };
  };
  assert.equal(provenance.generatorVersion, "1");
  assert.equal(provenance.serializerVersion, "iris-context-golden-v1");
  assert.equal(provenance.sourceRepository, "https://github.com/cortexkit/magic-context");
  assert.equal(provenance.release, AUTHORITY_RELEASE);
  assert.equal(provenance.authorityCommit, AUTHORITY_COMMIT);
  assert.ok(provenance.authoritativeFiles.length >= 7);
  // The committed constants.json must hash to the recorded value.
  const actual = sha256(readFileSync(join(FIXTURE_DIR, "constants.json"), "utf8"));
  assert.equal(actual, provenance.outputHashes.constantsJson);
});
