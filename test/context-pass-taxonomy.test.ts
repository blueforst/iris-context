import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  decidePass,
  prefixFingerprint,
  projectPrefix,
  type HardSignals,
} from "../src/context/pass-taxonomy.js";
import type { ContextLineage } from "../src/context/context-store.js";

function makeLineage(overrides: Partial<ContextLineage> = {}): ContextLineage {
  return {
    runtimeSessionId: "iris-runtime-2026-08-01-1",
    contextSourceSnapshotId: "src-1",
    epochId: "e1",
    personaSnapshotId: "persona-1",
    declarationVersion: "v1",
    providerProfileId: "mock",
    canonicalSystemPrompt: "sys",
    systemProjectionHash: "sh",
    preparedAt: "2026-08-01T12:00:00.000Z",
    materializationId: "mat-1",
    contextSerializerVersion: "iris-context-golden-v1",
    carrierSchemaVersion: "1",
    m0Body: "m0-baseline",
    m1Body: "m1-v1",
    m0ContentHash: "h0",
    m1ContentHash: "h1",
    m0MaterializedAt: 1_000,
    m1UpdatedAt: 1_000,
    cachedM0SystemHash: "sys-v1",
    cachedM0ModelKey: "model-v1",
    cachedM0ProviderProfileId: "mock",
    lastResponseTime: 500,
    representedThroughEntrySeq: 10,
    protectedTailStartEntrySeq: 5,
    lastSafeUserAnchorEntrySeq: 3,
    clearedReasoningThroughTag: 0,
    toolReclaimWatermark: 0,
    mutationReplayWatermark: 0,
    deferredSignalCursor: 0,
    emergencyState: "ok",
    lastTransformError: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

const BASE_HARD: HardSignals = {
  systemHash: "sys-v1",
  modelKey: "model-v1",
  providerProfileId: "mock",
  contextSerializerVersion: "iris-context-golden-v1",
  carrierSchemaVersion: "1",
  personaSnapshotId: "persona-1",
  declarationVersion: "v1",
  cacheExpired: false,
  lastResponseTime: 500,
};

test("pass-taxonomy: first_render is HARD when no lineage / no m0", () => {
  assert.deepEqual(decidePass(undefined, BASE_HARD, { wouldAdvanceLive: true }), {
    classification: "HARD",
    reason: "first_render",
    advancesMaterialization: true,
  });
  assert.deepEqual(
    decidePass(makeLineage({ m0Body: null }), BASE_HARD, { wouldAdvanceLive: true }),
    {
      classification: "HARD",
      reason: "first_render",
      advancesMaterialization: true,
    },
  );
});

test("pass-taxonomy: cached_m1_missing is HARD", () => {
  assert.deepEqual(
    decidePass(makeLineage({ m1Body: null }), BASE_HARD, { wouldAdvanceLive: true }),
    {
      classification: "HARD",
      reason: "cached_m1_missing",
      advancesMaterialization: true,
    },
  );
});

test("pass-taxonomy: SOFT+ byte-identical replay when nothing changes", () => {
  const decision = decidePass(makeLineage(), BASE_HARD, { wouldAdvanceLive: false });
  assert.deepEqual(decision, {
    classification: "SOFT+",
    reason: null,
    advancesMaterialization: false,
  });
});

test("pass-taxonomy: SOFT when live delta advances, m0/m1 stay", () => {
  const decision = decidePass(makeLineage(), BASE_HARD, { wouldAdvanceLive: true });
  assert.equal(decision.classification, "SOFT");
  assert.equal(decision.advancesMaterialization, true);
});

test("pass-taxonomy: HARD model_change folds", () => {
  const decision = decidePass(
    makeLineage(),
    { ...BASE_HARD, modelKey: "other-model" },
    { wouldAdvanceLive: true },
  );
  assert.equal(decision.classification, "HARD");
  assert.equal(decision.reason, "model_change");
});

test("pass-taxonomy: HARD system_hash", () => {
  const decision = decidePass(
    makeLineage(),
    { ...BASE_HARD, systemHash: "sys-v2" },
    { wouldAdvanceLive: true },
  );
  assert.equal(decision.classification, "HARD");
  assert.equal(decision.reason, "system_hash");
});

test("pass-taxonomy: empty HARD signal is never a change", () => {
  const decision = decidePass(
    makeLineage(),
    { systemHash: "", modelKey: "", cacheExpired: false, lastResponseTime: 0 },
    { wouldAdvanceLive: false },
  );
  assert.equal(decision.classification, "SOFT+", "unknown signal must not fold");
  assert.equal(decision.advancesMaterialization, false);
});

test("pass-taxonomy: ttl_idle folds once, then idempotent (materializedAt advances)", () => {
  // Materialized 1h ago; a response completed AFTER the baseline.
  const lineage = makeLineage({ m0MaterializedAt: Date.now() - 3_600_000, lastResponseTime: 0 });
  const ttlHard: HardSignals = {
    ...BASE_HARD,
    cacheExpired: true,
    lastResponseTime: Date.now() - 3_600_000 + 1_000,
  };
  const fold = decidePass(lineage, ttlHard, { wouldAdvanceLive: true });
  assert.equal(fold.classification, "HARD");
  assert.equal(fold.reason, "ttl_idle");

  // After the fold the materializedAt advanced past lastResponseTime → no re-fold.
  const afterFold = makeLineage({
    m0MaterializedAt: Date.now(),
    lastResponseTime: Date.now() - 3_600_000 + 1_000,
  });
  const again = decidePass(afterFold, ttlHard, { wouldAdvanceLive: true });
  assert.notEqual(again.reason, "ttl_idle", "same signals within the turn must not re-fold");
  assert.equal(again.classification, "SOFT");
});

test("pass-taxonomy: provider/serializer/carrier/persona/declaration changes are HARD", () => {
  const cases: Array<{ hard: HardSignals; reason: string }> = [
    { hard: { ...BASE_HARD, providerProfileId: "live" }, reason: "provider_profile_change" },
    {
      hard: { ...BASE_HARD, contextSerializerVersion: "v2" },
      reason: "serializer_change",
    },
    { hard: { ...BASE_HARD, carrierSchemaVersion: "2" }, reason: "carrier_schema_change" },
    { hard: { ...BASE_HARD, personaSnapshotId: "persona-2" }, reason: "persona_change" },
    { hard: { ...BASE_HARD, declarationVersion: "v2" }, reason: "declaration_change" },
    { hard: { ...BASE_HARD, manualMaintenance: true }, reason: "manual_maintenance" },
    { hard: { ...BASE_HARD, contextPressure: true }, reason: "context_pressure" },
  ];
  for (const { hard, reason } of cases) {
    const decision = decidePass(makeLineage(), hard, { wouldAdvanceLive: true });
    assert.equal(decision.classification, "HARD", reason);
    assert.equal(decision.reason, reason);
  }
});

test("pass-taxonomy: ordinary tool result never triggers P0/P1/P2 rebuild", () => {
  // A ToolResult that simply advances the live delta with NO HARD signal is
  // a SOFT pass — never a HARD fold (which would rebuild system/m0).
  const decision = decidePass(makeLineage(), BASE_HARD, { wouldAdvanceLive: true });
  assert.equal(decision.classification, "SOFT");
  assert.notEqual(decision.reason, "manual_maintenance");
});

test("pass-taxonomy: prefix bytes are stable and distinct per surface", () => {
  const prefix = projectPrefix("system-prompt", "m0-baseline", "m1-v1");
  assert.equal(prefix.system, "system-prompt");
  const again = projectPrefix("system-prompt", "m0-baseline", "m1-v1");
  assert.equal(prefixFingerprint(prefix), prefixFingerprint(again));
  const different = projectPrefix("system-prompt", "m0-baseline", "m1-v2");
  assert.notEqual(prefixFingerprint(prefix), prefixFingerprint(different));
});

test("pass-taxonomy: golden fixture matrix aligns with authority assertions", () => {
  // The committed golden fixtures encode the authority's OWN test assertions
  // (m0m1-taxonomy.test.ts @ v0.33.0). The pass decisions must match the
  // recorded passClassification.
  const fixtureDir = join(process.cwd(), "test", "fixtures", "context", "opencode-v0.33.0");
  const softplus = JSON.parse(
    readFileSync(join(fixtureDir, "taxonomy-softplus-defer-identical.json"), "utf8"),
  ) as { expected: { passClassification: string; rematerialized: boolean } };
  const soft = JSON.parse(
    readFileSync(join(fixtureDir, "taxonomy-soft-exec-surfaces-m1.json"), "utf8"),
  ) as { expected: { passClassification: string; rematerialized: boolean } };
  const hard = JSON.parse(
    readFileSync(join(fixtureDir, "taxonomy-hard-model-change.json"), "utf8"),
  ) as { expected: { passClassification: string; rematerialized: boolean; reason: string } };
  const empty = JSON.parse(
    readFileSync(join(fixtureDir, "taxonomy-empty-hard-signal-no-fold.json"), "utf8"),
  ) as { expected: { passClassification: string; rematerialized: boolean } };

  const lineage = makeLineage();

  // SOFT+: defer passes replay byte-identical.
  const d = decidePass(lineage, BASE_HARD, { wouldAdvanceLive: false });
  assert.equal(d.classification, "SOFT+");
  assert.equal(softplus.expected.passClassification, "SOFT+");
  assert.equal(d.advancesMaterialization, false);
  assert.equal(softplus.expected.rematerialized, false);

  // SOFT: exec pass re-renders m1.
  const s = decidePass(lineage, BASE_HARD, { wouldAdvanceLive: true });
  assert.equal(s.classification, "SOFT");
  assert.equal(soft.expected.passClassification, "SOFT");
  assert.equal(s.advancesMaterialization, true);
  assert.equal(soft.expected.rematerialized, false);

  // HARD: model change.
  const h = decidePass(
    lineage,
    { ...BASE_HARD, modelKey: "anthropic/sonnet" },
    { wouldAdvanceLive: true },
  );
  assert.equal(h.classification, "HARD");
  assert.equal(h.reason, "model_change");
  assert.equal(hard.expected.passClassification, "HARD");
  assert.equal(hard.expected.reason, "model_change");
  assert.equal(h.advancesMaterialization, true);
  assert.equal(hard.expected.rematerialized, true);

  // Empty HARD signal: no fold. The authority fixture records SOFT because
  // its scenario is an exec pass (isCacheBustingPass=true → m1 re-renders);
  // drive wouldAdvanceLive=true so the Iris decision matches the recorded
  // classification and parity is asserted, not just read (reviewer F3).
  const e = decidePass(
    lineage,
    { systemHash: "", modelKey: "", cacheExpired: false, lastResponseTime: 0 },
    { wouldAdvanceLive: true },
  );
  assert.equal(e.classification, "SOFT");
  assert.equal(e.advancesMaterialization, true);
  assert.equal(empty.expected.passClassification, "SOFT");
  assert.equal(e.classification, empty.expected.passClassification);
  assert.equal(empty.expected.rematerialized, false);
});
