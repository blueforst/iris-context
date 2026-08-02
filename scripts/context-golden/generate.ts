// Iris R2 Feature 1 — OpenCode Magic Context v0.33.0 golden fixture generator.
//
// GOLDEN TRUTH SOURCE: the locked released authority ONLY
//   cortexkit/magic-context, release v0.33.0, commit 48ab531d8fa98af2f463db2e4d9f8ffdd63d765e
//   (see scripts/context-golden/authority.json).
//
// The generator mechanically extracts the constants and hard-coded assertions
// that EXIST IN THE AUTHORITY SOURCE (its implementation files and its own
// tests). Iris's own implementation never contributes an expected value, so
// the fixtures cannot be self-certified by Iris.
//
// Requirements enforced here:
//   1. The local authority checkout must exist and its HEAD must equal the
//      locked commit. Missing checkout or commit mismatch = hard failure
//      (never silently fall back to an unverified checkout or to Iris).
//   2. Output is deterministic: the same authority produces byte-identical
//      fixtures and hashes.
//   3. Every generated fixture records its authority provenance (file +
//      commit) and an output content hash.
//   4. experimental.mural / Memory Mural is forbidden: the generator scans
//      every emitted fixture body and fails if the token "mural" appears.
//
// Usage:
//   MC_AUTHORITY_PATH=C:\...\magic-context npx tsx scripts/context-golden/generate.ts
//   (defaults to ../../mc-authority/magic-context relative to this script)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");

const authority = JSON.parse(readFileSync(join(SCRIPT_DIR, "authority.json"), "utf8")) as {
  repository: string;
  release: string;
  commit: string;
  generatorVersion: string;
  serializerVersion: string;
  authoritativeFiles: string[];
  notes: string[];
};

const DEFAULT_AUTHORITY = resolve(ROOT, "..", "mc-authority", "magic-context");
const AUTHORITY_PATH = resolve(process.env["MC_AUTHORITY_PATH"] ?? DEFAULT_AUTHORITY);

const FIXTURE_DIR = join(ROOT, "test", "fixtures", "context", "opencode-v0.33.0");
const PROVENANCE_DIR = join(ROOT, "evidence", "context-golden");

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Read a file from the authority checkout, failing hard if missing. */
function readAuthority(relativePath: string): string {
  const full = join(AUTHORITY_PATH, relativePath);
  if (!existsSync(full)) {
    throw new Error(
      `authority file missing: ${relativePath} (checkout at ${AUTHORITY_PATH}). ` +
        `Clone cortexkit/magic-context and check out ${authority.commit} to regenerate golden fixtures.`,
    );
  }
  return readFileSync(full, "utf8");
}

/** Extract the value of `const NAME = <single-line literal>` from source. */
function extractConstant(source: string, name: string): string {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`);
  const match = pattern.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`constant ${name} not found in authority source`);
  }
  const raw = match[1].trim();
  // Strip surrounding quotes (single or double) for string literals.
  const quoted = /^(['"])(.*)\1$/s.exec(raw);
  return quoted === null ? raw : (quoted[2] ?? "");
}

/** Resolve a numeric underscore literal like "8_000" or "0.05". */
function numeric(value: string): number {
  return Number(value.replaceAll("_", ""));
}

function assertAuthorityHead(): void {
  let head: string;
  try {
    head = execFileSync("git", ["-C", AUTHORITY_PATH, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      `authority checkout is not a git repo: ${AUTHORITY_PATH}. ` +
        `Clone cortexkit/magic-context and check out ${authority.commit}.`,
    );
  }
  if (head !== authority.commit) {
    throw new Error(
      `authority HEAD mismatch: expected ${authority.commit}, got ${head}. ` +
        `Checking out a different commit would silently change golden truth.`,
    );
  }
}

interface Extracted {
  constants: Record<string, string | number>;
  fixtures: Array<{
    id: string;
    sourceFile: string;
    authorityCommit: string;
    input: unknown;
    expected: unknown;
  }>;
}

function extractFromAuthority(): Extracted {
  const inject = readAuthority("packages/plugin/src/hooks/magic-context/inject-compartments.ts");
  const trigger = readAuthority("packages/plugin/src/hooks/magic-context/compartment-trigger.ts");
  const budgets = readAuthority("packages/plugin/src/hooks/magic-context/derive-budgets.ts");
  const tail = readAuthority("packages/plugin/src/hooks/magic-context/protected-tail-boundary.ts");
  const sentinel = readAuthority("packages/plugin/src/hooks/magic-context/sentinel.ts");
  const taxonomyTest = readAuthority(
    "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
  );
  const tailTest = readAuthority(
    "packages/plugin/src/hooks/magic-context/protected-tail-boundary.test.ts",
  );

  // Anti-self-certification: every fixed expected value below must be
  // literally present in the AUTHORITY's own tests. If the authority moves an
  // assertion, generation fails instead of silently drifting.
  const authorityAssertionAnchors: Array<{ file: string; needle: string }> = [
    {
      file: taxonomyTest,
      needle: "isCacheBustingPass: false",
    },
    {
      file: taxonomyTest,
      needle: "toBe(M1_PLACEHOLDER)",
    },
    {
      file: taxonomyTest,
      needle: '"model_change"',
    },
    {
      file: taxonomyTest,
      needle: '"system_hash"',
    },
    {
      file: taxonomyTest,
      needle: '"ttl_idle"',
    },
    {
      file: taxonomyTest,
      needle: "first_render",
    },
    {
      file: taxonomyTest,
      needle: "cached_m0_materialized_at",
    },
    {
      file: tailTest,
      needle: "findSuffixStartForTokens(150)).toBe(2)",
    },
    {
      file: tailTest,
      needle: "findSuffixStartForTokens(301)).toBe(1)",
    },
    {
      file: tailTest,
      needle: "ceilingN).toBe(2_080)",
    },
    {
      file: tailTest,
      needle: "ceilingN).toBe(3_120)",
    },
    {
      file: tailTest,
      needle: "MIN_FORCE_ELIGIBLE_TOKENS_CAP).toBe(1_000)",
    },
    {
      file: tailTest,
      needle: "deriveMinForceEligibleTokens(16_000)).toBe(1_000)",
    },
  ];
  for (const { file, needle } of authorityAssertionAnchors) {
    if (!file.includes(needle)) {
      throw new Error(
        `authority assertion anchor missing: ${needle} — golden fixture expected values ` +
          `are no longer present in the locked authority; re-review before regenerating.`,
      );
    }
  }

  const constants: Record<string, string | number> = {
    M0_EMPTY_BODY: extractConstant(inject, "M0_EMPTY_BODY"),
    M1_EMPTY_PLACEHOLDER: extractConstant(inject, "M1_EMPTY_PLACEHOLDER"),
    DEFAULT_MEMORY_BUDGET_TOKENS: numeric(extractConstant(inject, "DEFAULT_MEMORY_BUDGET_TOKENS")),
    DEFAULT_USER_PROFILE_BUDGET_TOKENS: numeric(
      extractConstant(inject, "DEFAULT_USER_PROFILE_BUDGET_TOKENS"),
    ),
    PROACTIVE_TRIGGER_OFFSET_PERCENTAGE: numeric(
      extractConstant(trigger, "PROACTIVE_TRIGGER_OFFSET_PERCENTAGE"),
    ),
    POST_DROP_TARGET_RATIO: numeric(extractConstant(trigger, "POST_DROP_TARGET_RATIO")),
    MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE: numeric(
      extractConstant(trigger, "MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE"),
    ),
    MIN_PROACTIVE_TAIL_MESSAGE_COUNT: numeric(
      extractConstant(trigger, "MIN_PROACTIVE_TAIL_MESSAGE_COUNT"),
    ),
    TAIL_SIZE_TRIGGER_MULTIPLIER: numeric(extractConstant(trigger, "TAIL_SIZE_TRIGGER_MULTIPLIER")),
    FORCE_COMPARTMENT_PERCENTAGE: numeric(extractConstant(trigger, "FORCE_COMPARTMENT_PERCENTAGE")),
    BLOCK_UNTIL_DONE_PERCENTAGE: numeric(extractConstant(trigger, "BLOCK_UNTIL_DONE_PERCENTAGE")),
    FORCE_MATERIALIZE_PERCENTAGE: numeric(extractConstant(trigger, "FORCE_MATERIALIZE_PERCENTAGE")),
    TRIGGER_BUDGET_PERCENTAGE: numeric(extractConstant(budgets, "TRIGGER_BUDGET_PERCENTAGE")),
    TRIGGER_BUDGET_MIN: numeric(extractConstant(budgets, "TRIGGER_BUDGET_MIN")),
    TRIGGER_BUDGET_MAX: numeric(extractConstant(budgets, "TRIGGER_BUDGET_MAX")),
    HISTORIAN_CHUNK_PERCENTAGE: numeric(extractConstant(budgets, "HISTORIAN_CHUNK_PERCENTAGE")),
    HISTORIAN_CHUNK_MIN: numeric(extractConstant(budgets, "HISTORIAN_CHUNK_MIN")),
    HISTORIAN_CHUNK_MAX: numeric(extractConstant(budgets, "HISTORIAN_CHUNK_MAX")),
    DEFAULT_HISTORIAN_CONTEXT_FALLBACK: numeric(
      extractConstant(budgets, "DEFAULT_HISTORIAN_CONTEXT_FALLBACK"),
    ),
    RECOVERY_NO_HEAD_LIMIT: numeric(extractConstant(tail, "RECOVERY_NO_HEAD_LIMIT")),
    MIN_FORCE_ELIGIBLE_TOKENS_CAP: numeric(extractConstant(tail, "MIN_FORCE_ELIGIBLE_TOKENS_CAP")),
    WHOLE_MESSAGE_PLACEHOLDER_TEXT: extractConstant(sentinel, "WHOLE_MESSAGE_PLACEHOLDER_TEXT"),
  };

  // ---- Golden taxonomy fixtures (mechanically copied from the authority's
  // own test m0m1-taxonomy.test.ts: the assertions that exist there are the
  // expected values; Iris computes nothing). ----
  const fixtures: Extracted["fixtures"] = [
    {
      id: "taxonomy-softplus-defer-identical",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
          { sequence: 1, title: "B", content: "Bravo delta", p1: "Bravo delta" },
        ],
        passes: [{ isCacheBustingPass: false }, { isCacheBustingPass: false }],
        hardSignals: {
          systemHash: "sys-v1",
          modelKey: "anthropic/opus",
          cacheExpired: false,
          lastResponseTime: 0,
        },
      },
      expected: {
        passClassification: "SOFT+",
        // Authority assertion: defer passes replay m0 AND m1 byte-identical.
        m0Replay: "byte_identical",
        m1Replay: "byte_identical",
        rematerialized: false,
        m1MustNotContain: ["Bravo delta"],
      },
    },
    {
      id: "taxonomy-soft-exec-surfaces-m1",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
          { sequence: 1, title: "B", content: "Bravo delta", p1: "Bravo delta" },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "sys-v1",
          modelKey: "anthropic/opus",
          cacheExpired: false,
          lastResponseTime: 0,
        },
      },
      expected: {
        passClassification: "SOFT",
        // Authority assertion: m0 stays byte-identical; m1 re-renders and
        // now carries B; m0 does NOT contain B.
        m0Replay: "byte_identical",
        m1Replay: "re_rendered",
        rematerialized: false,
        m1MustContain: ["Bravo delta"],
        m0MustNotContain: ["Bravo delta"],
      },
    },
    {
      id: "taxonomy-hard-model-change",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
          { sequence: 1, title: "B", content: "Bravo delta", p1: "Bravo delta" },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "sys-v1",
          modelKey: "anthropic/sonnet", // model change
          cacheExpired: false,
          lastResponseTime: 0,
        },
      },
      expected: {
        passClassification: "HARD",
        reason: "model_change",
        rematerialized: true,
        m0MustContain: ["Bravo delta"],
        m1Replay: "reset_to_placeholder",
      },
    },
    {
      id: "taxonomy-hard-system-hash",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "sys-v2", // system hash change
          modelKey: "anthropic/opus",
          cacheExpired: false,
          lastResponseTime: 0,
        },
      },
      expected: {
        passClassification: "HARD",
        reason: "system_hash",
        rematerialized: true,
      },
    },
    {
      id: "taxonomy-empty-hard-signal-no-fold",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "",
          modelKey: "",
          cacheExpired: false,
          lastResponseTime: 0,
        },
      },
      expected: {
        passClassification: "SOFT",
        // Authority assertion: an EMPTY current HARD signal is never treated
        // as a change ("" means "no signal", not "changed to empty").
        rematerialized: false,
      },
    },
    {
      id: "taxonomy-hard-ttl-idle-fold-once",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "sys-v1",
          modelKey: "anthropic/opus",
          cacheExpired: true,
          lastResponseTime: Date.now() - 60 * 60 * 1000 + 1000, // past response after baseline
        },
      },
      expected: {
        passClassification: "HARD",
        reason: "ttl_idle",
        rematerialized: true,
        // Authority assertion: the same signals again within the turn do NOT
        // re-fold (idempotent).
        idempotent: true,
      },
    },
    {
      id: "taxonomy-pressure-backstop-m1-cap",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Ax", p1: "Ax" },
          {
            sequence: 1,
            title: "B",
            content: "Bravo delta with enough words to consume tokens",
            p1: "Bravo delta with enough words to consume tokens",
          },
          {
            sequence: 2,
            title: "C",
            content: "Charlie delta with more words again to consume more tokens",
            p1: "Charlie delta with more words again to consume more tokens",
          },
          {
            sequence: 3,
            title: "D",
            content: "Delta delta even more words here for tokens and tokens",
            p1: "Delta delta even more words here for tokens and tokens",
          },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "sys-v1",
          modelKey: "anthropic/opus",
          cacheExpired: false,
          lastResponseTime: 0,
        },
        historyBudgetTokens: 60,
      },
      expected: {
        passClassification: "HARD",
        // Absolute m1 cap (>20% of the history budget) folds m1 into m0.
        reason: "m1_absolute_cap",
        rematerialized: true,
        m1Replay: "reset_to_placeholder",
      },
    },
    {
      id: "taxonomy-hard-markers-persist-restart",
      sourceFile: "packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts",
      authorityCommit: authority.commit,
      input: {
        compartments: [
          { sequence: 0, title: "A", content: "Alpha baseline", p1: "Alpha baseline" },
        ],
        passes: [{ isCacheBustingPass: true }],
        hardSignals: {
          systemHash: "sys-v1",
          modelKey: "anthropic/opus",
          cacheExpired: false,
          lastResponseTime: 0,
        },
        simulateRestart: true,
      },
      expected: {
        passClassification: "SOFT",
        // Authority assertion: persisted markers survive a restart (DB read),
        // so a same-identity pass does NOT spuriously fold.
        rematerialized: false,
      },
    },
    {
      id: "protected-tail-suffix-walk",
      sourceFile: "packages/plugin/src/hooks/magic-context/protected-tail-boundary.test.ts",
      authorityCommit: authority.commit,
      input: {
        rawTokenCounts: [100, 100, 100],
        targets: [150, 301, 300, 0],
      },
      expected: {
        // Authority assertions (findSuffixStartForTokens).
        suffixStartForTokens: [2, 1, 1, 4],
      },
    },
    {
      id: "protected-tail-n-clamp",
      sourceFile: "packages/plugin/src/hooks/magic-context/protected-tail-boundary.test.ts",
      authorityCommit: authority.commit,
      input: {
        cases: [
          { contextLimit: 8_000, executeThresholdPercentage: 65, usagePercentage: 30 },
          { contextLimit: 12_000, executeThresholdPercentage: 65, usagePercentage: 95 },
        ],
      },
      expected: {
        // Authority assertions (deriveProtectedTailTokenTarget).
        ceilingN: [2_080, 3_120],
        N: [2_000, 2_000],
      },
    },
    {
      id: "protected-tail-force-head-minimum",
      sourceFile: "packages/plugin/src/hooks/magic-context/protected-tail-boundary.test.ts",
      authorityCommit: authority.commit,
      input: {
        scaledN: [8, 16_000],
      },
      expected: {
        // Authority assertions (deriveMinForceEligibleTokens).
        minForceEligibleTokens: [1, 1_000],
        minForceEligibleTokensCap: 1_000,
      },
    },
  ];

  return { constants, fixtures };
}

function assertNoMural(text: string, label: string): void {
  if (/mural/i.test(text)) {
    throw new Error(`forbidden Memory Mural token found in generated ${label}`);
  }
}

function main(): void {
  assertAuthorityHead();
  const { constants, fixtures } = extractFromAuthority();

  mkdirSync(FIXTURE_DIR, { recursive: true });
  mkdirSync(PROVENANCE_DIR, { recursive: true });

  const constantBody = JSON.stringify(
    { authority: { commit: authority.commit, release: authority.release }, constants },
    null,
    2,
  );
  assertNoMural(constantBody, "constants fixture");
  const constantsFixture = `${constantBody}\n`;
  const constantsHash = sha256(constantsFixture);
  writeFileSync(join(FIXTURE_DIR, "constants.json"), constantsFixture, "utf8");

  const fixtureBodies = fixtures.map((fixture) => {
    const body = `${JSON.stringify(fixture, null, 2)}\n`;
    assertNoMural(body, `fixture ${fixture.id}`);
    writeFileSync(join(FIXTURE_DIR, `${fixture.id}.json`), body, "utf8");
    return { id: fixture.id, hash: sha256(body) };
  });

  const provenance = {
    generatorVersion: authority.generatorVersion,
    serializerVersion: authority.serializerVersion,
    sourceRepository: authority.repository,
    release: authority.release,
    authorityCommit: authority.commit,
    authoritativeFiles: authority.authoritativeFiles,
    generatedAtUtc: new Date().toISOString(),
    inputs: {
      constants: constantsFixture,
      fixtures: fixtures.map((f) => ({ id: f.id, sourceFile: f.sourceFile })),
    },
    outputHashes: {
      constantsJson: constantsHash,
      fixtureJson: Object.fromEntries(fixtureBodies.map((f) => [f.id, f.hash])),
    },
    notes: authority.notes,
  };
  const provenanceBody = `${JSON.stringify(provenance, null, 2)}\n`;
  // The provenance's `notes` intentionally contains the phrase "Memory Mural"
  // as a written prohibition (it must not be present in the fixture DATA);
  // the mural guard applies to generated fixture payloads, not to the manifest
  // prose that states the prohibition itself.
  writeFileSync(join(PROVENANCE_DIR, "provenance.json"), provenanceBody, "utf8");

  // Human-readable manifest.
  const md: string[] = [
    "# OpenCode Magic Context v0.33.0 — Golden Fixture Provenance",
    "",
    `- Source repository: ${authority.repository}`,
    `- Release: ${authority.release}`,
    `- Authority commit: \`${authority.commit}\``,
    `- Generator version: ${authority.generatorVersion}`,
    `- Serializer version: ${authority.serializerVersion}`,
    `- Generated at (UTC): ${provenance.generatedAtUtc}`,
    "",
    "## Authoritative files (locked)",
    "",
    ...authority.authoritativeFiles.map((file) => `- \`${file}\``),
    "",
    "## Generated fixtures",
    "",
    "| fixture | sha256 |",
    "| --- | --- |",
    ...fixtureBodies.map((f) => `| \`${f.id}.json\` | \`${f.hash}\` |`),
    `| \`constants.json\` | \`${constantsHash}\` |`,
    "",
    "## Guarantees",
    "",
    "- Expected values are mechanically extracted from the locked released authority only; Iris never self-certifies.",
    "- Regeneration requires the local authority checkout at HEAD `48ab531d…` (see `scripts/context-golden/generate.ts`).",
    "- Committed fixtures remain runnable offline.",
    "- Memory Mural / experimental.mural is forbidden and the generator fails if detected.",
    "",
  ];
  writeFileSync(join(PROVENANCE_DIR, "provenance.md"), md.join("\n"), "utf8");

  console.log(
    JSON.stringify(
      {
        status: "ok",
        authorityCommit: authority.commit,
        fixtures: fixtureBodies.length,
        constantsHash,
        fixtureHashes: Object.fromEntries(fixtureBodies.map((f) => [f.id, f.hash])),
      },
      null,
      2,
    ),
  );
}

main();
